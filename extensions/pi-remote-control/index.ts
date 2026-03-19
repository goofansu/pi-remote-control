/**
 * remote-control — Expose the running pi session over HTTP/WebSocket.
 *
 * Starts an HTTP + WebSocket server on a free port, bound to 127.0.0.1 (localhost only).
 * This is intended to sit behind a local port-forwarding proxy/tunnel that terminates on
 * the same host (for example Tailscale/Surge), rather than accepting direct LAN traffic.
 * Access requires a one-time token (?token=...) which sets a session cookie for
 * subsequent requests. Run /remote-control to start the server and display the URL.
 * The browser is expected to use http(s):// and ws(s):// through that proxy.
 * The server stops automatically when the session closes.
 */

import { createServer } from "node:http";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Key, Text, matchesKey } from "@mariozechner/pi-tui";


// Load ws (bundled with pi) without needing @types/ws installed locally
const _require = createRequire(import.meta.url);
const wsModule = _require("ws") as {
	WebSocketServer: new (opts: { noServer: boolean }) => any;
	OPEN: number;
};
const { WebSocketServer, OPEN } = wsModule;

const REMOTE_CONTROL_CONFIG_FILE = "remote-control.json";

interface RemoteControlConfig {
	publicBaseUrl?: string;
}

function getAgentDir(): string {
	const envCandidates = ["PI_CODING_AGENT_DIR", "TAU_CODING_AGENT_DIR"];
	let envDir: string | undefined;
	for (const key of envCandidates) {
		if (process.env[key]) {
			envDir = process.env[key];
			break;
		}
	}
	if (!envDir) {
		for (const [key, value] of Object.entries(process.env)) {
			if (key.endsWith("_CODING_AGENT_DIR") && value) {
				envDir = value;
				break;
			}
		}
	}

	if (envDir === "~") return os.homedir();
	if (envDir?.startsWith("~/")) return path.join(os.homedir(), envDir.slice(2));
	return envDir ?? path.join(os.homedir(), ".pi", "agent");
}

function getRemoteControlConfigPath(): string {
	return path.join(getAgentDir(), REMOTE_CONTROL_CONFIG_FILE);
}

async function readRemoteControlConfig(): Promise<RemoteControlConfig> {
	try {
		const raw = await fs.readFile(getRemoteControlConfigPath(), "utf8");
		const parsed = JSON.parse(raw) as RemoteControlConfig;
		if (!parsed || typeof parsed !== "object") return {};
		return parsed;
	} catch {
		return {};
	}
}

async function writeRemoteControlConfig(config: RemoteControlConfig): Promise<void> {
	const configPath = getRemoteControlConfigPath();
	await fs.mkdir(path.dirname(configPath), { recursive: true });
	await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

function normalizePublicBaseUrl(value: string): string {
	const parsed = new URL(value.trim());
	parsed.username = "";
	parsed.password = "";
	parsed.pathname = "";
	parsed.search = "";
	parsed.hash = "";
	return parsed.toString().replace(/\/+$/, "");
}

function buildRemoteControlUrl(publicBaseUrl: string, port: number, token: string): string {
	const parsed = new URL(normalizePublicBaseUrl(publicBaseUrl));
	if (parsed.protocol === "http:") {
		parsed.port = String(port);
	}
	parsed.searchParams.set("token", token);
	return parsed.toString();
}

async function configureRemoteControlUI(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;

	const current = (await readRemoteControlConfig()).publicBaseUrl ?? "";
	const raw = await ctx.ui.input("Remote-control public base URL", current || "e.g. http://pi.sgponte");
	if (raw === undefined) return;

	let value: string;
	try {
		value = normalizePublicBaseUrl(raw);
	} catch {
		ctx.ui.notify("Public base URL must be a valid http:// or https:// URL", "warning");
		return;
	}
	if (!["http:", "https:"].includes(new URL(value).protocol)) {
		ctx.ui.notify("Public base URL must start with http:// or https://", "warning");
		return;
	}

	await writeRemoteControlConfig({ publicBaseUrl: value });
	ctx.ui.notify(`Saved remote-control URL to ${getRemoteControlConfigPath()}`, "info");
}

// ── Auth helpers ─────────────────────────────────────────────────────────────

function generateToken(): string {
	return randomBytes(24).toString("base64url"); // 32 chars, URL-safe
}

function validateToken(provided: string, expected: string): boolean {
	const a = Buffer.from(provided);
	const b = Buffer.from(expected);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/** Name of the cookie that grants access after initial token validation */
const SESSION_COOKIE = "pi_rc_session";

function generateSessionId(): string {
	return randomBytes(24).toString("base64url");
}

function parsecookies(header: string | undefined): Record<string, string> {
	const cookies: Record<string, string> = {};
	if (!header) return cookies;
	for (const pair of header.split(";")) {
		const idx = pair.indexOf("=");
		if (idx < 0) continue;
		const name = pair.slice(0, idx).trim();
		const raw = pair.slice(idx + 1).trim();
		let value = raw;
		try { value = decodeURIComponent(raw); } catch { /* keep raw */ }
		cookies[name] = value;
	}
	return cookies;
}

// ── Wire protocol types ──────────────────────────────────────────────────────

interface RenderMsg {
	id: string; // SessionEntry id, or "pending" while streaming
	role: "user" | "assistant" | "tool_result";
	text: string;
	toolCalls?: Array<{ id: string; name: string; args: string }>;
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
	model?: string;
}

// ── Message serialization ────────────────────────────────────────────────────

function serializeMessage(id: string, msg: any): RenderMsg | null {
	if (msg.role === "user") {
		const text =
			typeof msg.content === "string"
				? msg.content
				: (msg.content as any[])
						.filter((c) => c.type === "text")
						.map((c) => c.text)
						.join("");
		return { id, role: "user", text };
	}

	if (msg.role === "assistant") {
		const text = (msg.content as any[])
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("");
		const toolCalls = (msg.content as any[])
			.filter((c) => c.type === "toolCall")
			.map((c) => ({
				id: c.id,
				name: c.name,
				args: JSON.stringify(c.arguments, null, 2),
			}));
		return {
			id,
			role: "assistant",
			text,
			toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
			model: msg.model,
		};
	}

	if (msg.role === "toolResult") {
		const text = (msg.content as any[])
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("");
		return {
			id,
			role: "tool_result",
			text,
			toolName: msg.toolName,
			toolCallId: msg.toolCallId,
			isError: msg.isError,
		};
	}

	return null;
}

function getBranchMessages(ctx: ExtensionContext): RenderMsg[] {
	const branch = ctx.sessionManager.getBranch();
	const out: RenderMsg[] = [];
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const m = serializeMessage(entry.id, (entry as any).message);
		if (m) out.push(m);
	}
	return out;
}

// ── Inlined web UI ───────────────────────────────────────────────────────────

function buildHTML(nonce: string): string {
return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, interactive-widget=resizes-content">
  <title>Pi Remote</title>
  <style nonce="${nonce}">
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:        #0d1117;
      --bg2:       #161b22;
      --bg3:       #21262d;
      --border:    #30363d;
      --text:      #e6edf3;
      --muted:     #8b949e;
      --user:      #58a6ff;
      --asst:      #3fb950;
      --tool:      #bc8cff;
      --tool-err:  #f85149;
      --streaming: #e3b341;
    }

    html, body {
      height: 100%;
      overflow: hidden;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      font-size: 14px;
      line-height: 1.5;
      touch-action: manipulation;
      -webkit-text-size-adjust: 100%;
      -webkit-tap-highlight-color: transparent;
    }

    #layout {
      position: fixed;
      inset: 0;
      display: flex;
      flex-direction: column;
    }

    /* ── Status bar ── */
    #statusbar {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 6px 14px;
      background: var(--bg2);
      border-bottom: 1px solid var(--border);
      font-size: 12px;
      color: var(--muted);
    }
    #statusbar .dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: #555;
      flex-shrink: 0;
    }
    #statusbar .dot.connected  { background: var(--asst); }
    #statusbar .dot.streaming  { background: var(--streaming); animation: pulse 1s infinite; }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }

    /* ── Messages ── */
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px 0;
    }

    .msg {
      padding: 8px 16px;
    }
    .msg:hover { background: var(--bg2); }

    .msg-header {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 4px;
    }
    .role-label {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      flex-shrink: 0;
    }
    .msg-user .role-label      { color: var(--user); }
    .msg-asst .role-label      { color: var(--asst); }
    .msg-tool .role-label      { color: var(--tool); }
    .msg-tool.err .role-label  { color: var(--tool-err); }
    .msg-streaming .role-label { color: var(--streaming); }

    .model-tag {
      font-size: 11px;
      color: var(--muted);
    }

    .msg-body {
      word-break: break-word;
    }
    .msg-user .msg-body {
      white-space: pre-wrap;
    }

    /* ── Markdown rendering (assistant) ── */
    .msg-asst .msg-body p { margin: 0 0 8px 0; }
    .msg-asst .msg-body p:last-child { margin-bottom: 0; }
    .msg-asst .msg-body h1,
    .msg-asst .msg-body h2,
    .msg-asst .msg-body h3,
    .msg-asst .msg-body h4,
    .msg-asst .msg-body h5,
    .msg-asst .msg-body h6 {
      margin: 16px 0 8px;
      font-weight: 600;
      line-height: 1.3;
      color: var(--text);
    }
    .msg-asst .msg-body h1 { font-size: 1.4em; }
    .msg-asst .msg-body h2 { font-size: 1.25em; }
    .msg-asst .msg-body h3 { font-size: 1.1em; }
    .msg-asst .msg-body code {
      font-family: "Menlo", "Monaco", "Consolas", monospace;
      font-size: 0.88em;
      background: var(--bg3);
      padding: 2px 5px;
      border-radius: 4px;
      color: #f0883e;
    }
    .msg-asst .msg-body pre {
      margin: 8px 0;
      padding: 12px;
      background: var(--bg2);
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }
    .msg-asst .msg-body pre code {
      background: none;
      padding: 0;
      border-radius: 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }
    .msg-asst .msg-body ul,
    .msg-asst .msg-body ol {
      margin: 6px 0;
      padding-left: 22px;
    }
    .msg-asst .msg-body li { margin: 3px 0; }
    .msg-asst .msg-body li > p { margin: 0; }
    .msg-asst .msg-body blockquote {
      margin: 8px 0;
      padding: 4px 12px;
      border-left: 3px solid var(--border);
      color: var(--muted);
    }
    .msg-asst .msg-body a {
      color: var(--user);
      text-decoration: none;
    }
    .msg-asst .msg-body a:hover { text-decoration: underline; }
    .msg-asst .msg-body hr {
      border: none;
      border-top: 1px solid var(--border);
      margin: 12px 0;
    }
    .msg-asst .msg-body table {
      border-collapse: collapse;
      margin: 8px 0;
      font-size: 13px;
      width: 100%;
    }
    .msg-asst .msg-body th,
    .msg-asst .msg-body td {
      border: 1px solid var(--border);
      padding: 5px 10px;
      text-align: left;
    }
    .msg-asst .msg-body th {
      background: var(--bg3);
      font-weight: 600;
    }
    .msg-asst .msg-body strong { font-weight: 600; }
    .msg-asst .msg-body em { font-style: italic; }

    /* ── Tool calls (collapsible) ── */
    details.tool-call {
      margin-top: 6px;
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
    }
    details.tool-call summary {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 5px 10px;
      background: var(--bg3);
      cursor: pointer;
      user-select: none;
      font-family: "Menlo", "Monaco", "Consolas", monospace;
      font-size: 12px;
      color: var(--tool);
      list-style: none;
    }
    details.tool-call summary::-webkit-details-marker { display: none; }
    details.tool-call summary::before {
      content: "▶";
      font-size: 9px;
      transition: transform 0.15s;
    }
    details[open].tool-call summary::before { transform: rotate(90deg); }
    details.tool-call pre {
      padding: 10px;
      font-family: "Menlo", "Monaco", "Consolas", monospace;
      font-size: 12px;
      overflow-x: auto;
      background: var(--bg);
      color: var(--muted);
      white-space: pre-wrap;
      word-break: break-all;
    }

    /* ── Tool results ── */
    .msg-tool .msg-body {
      font-family: "Menlo", "Monaco", "Consolas", monospace;
      font-size: 12px;
      color: var(--muted);
      white-space: pre-wrap;
    }
    .msg-tool.err .msg-body { color: var(--tool-err); }

    details.tool-output summary {
      cursor: pointer;
      user-select: none;
      list-style: none;
      font-size: 12px;
      color: var(--muted);
      padding: 2px 0;
    }
    details.tool-output summary::-webkit-details-marker { display: none; }
    details.tool-output summary::before { content: "▸ "; }
    details[open].tool-output summary::before { content: "▾ "; }

    /* ── Streaming cursor ── */
    .msg-streaming .msg-body > *:last-child::after,
    .msg-streaming .msg-body:not(:has(*))::after {
      content: "";
      display: inline-block;
      width: 7px; height: 13px;
      background: var(--streaming);
      margin-left: 2px;
      vertical-align: text-bottom;
      animation: blink 0.8s step-end infinite;
    }
    @keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0; } }

    /* ── Active tools indicator ── */
    #active-tools { padding: 4px 16px; min-height: 0; }
    .active-tool {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 8px;
      margin: 2px 4px 2px 0;
      border-radius: 4px;
      background: var(--bg3);
      border: 1px solid var(--border);
      font-family: "Menlo", "Monaco", "Consolas", monospace;
      font-size: 12px;
      color: var(--streaming);
    }
    .spin { animation: spin 1s linear infinite; display: inline-block; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── Input area ── */
    #input-area {
      flex-shrink: 0;
      display: flex;
      align-items: flex-end;
      gap: 8px;
      padding: 8px 10px;
      padding-bottom: max(8px, env(safe-area-inset-bottom));
      background: var(--bg2);
      border-top: 1px solid var(--border);
    }
    #prompt {
      flex: 1;
      resize: none;
      background: var(--bg3);
      border: 1px solid var(--border);
      border-radius: 20px;
      color: var(--text);
      font-family: inherit;
      font-size: 16px;
      padding: 9px 14px;
      outline: none;
      min-height: 40px;
      max-height: 120px;
      overflow-y: auto;
      line-height: 1.4;
      -webkit-appearance: none;
      appearance: none;
      transition: border-color 0.15s;
    }
    #prompt:focus { border-color: var(--user); }
    #prompt::placeholder { color: var(--muted); }
    #send-btn {
      width: 40px;
      height: 40px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--border);
      color: var(--muted);
      border: none;
      border-radius: 50%;
      cursor: pointer;
      transition: background 0.15s, color 0.15s, transform 0.1s;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
    }
    #send-btn.ready {
      background: var(--user);
      color: #fff;
    }
    #send-btn.ready:active { transform: scale(0.9); }
    #send-btn:disabled {
      background: var(--border);
      color: var(--muted);
      opacity: 0.4;
      cursor: default;
    }
    #send-btn svg {
      width: 20px;
      height: 20px;
      fill: currentColor;
    }

    #messages::-webkit-scrollbar { width: 6px; }
    #messages::-webkit-scrollbar-track { background: transparent; }
    #messages::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  </style>
</head>
<body>
<div id="layout">
  <div id="statusbar">
    <div class="dot" id="dot"></div>
    <span id="conn-label">Connecting\u2026</span>
    <span style="flex:1"></span>
  </div>
  <div id="messages"></div>
  <div id="active-tools"></div>
  <div id="input-area">
    <textarea id="prompt" placeholder="Message\u2026" rows="1"></textarea>
    <button id="send-btn" disabled aria-label="Send"><svg viewBox="0 0 24 24"><path d="M3.4 20.4l17.45-7.48a1 1 0 000-1.84L3.4 3.6a.993.993 0 00-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z"/></svg></button>
  </div>
</div>
<script nonce="${nonce}">
(function () {
  "use strict";

  var S = {
    msgs: [],
    pending: null,
    tools: {},
    streaming: false,
    model: null,
  };

  var $msgs      = document.getElementById("messages");
  var $active    = document.getElementById("active-tools");
  var $dot       = document.getElementById("dot");
  var $connLabel = document.getElementById("conn-label");
  var $prompt    = document.getElementById("prompt");
  var $sendBtn   = document.getElementById("send-btn");

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // Inline markdown renderer — no external deps, HTML-safe (no raw HTML passthrough)
  function renderMd(src) {
    if (!src) return "";
    function escH(s) {
      return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    }
    function inl(s) {
      var ph = [], ci = 0;
      s = s.replace(/\x60([^\x60\\n]+)\x60/g, function(_,c){ph.push("<code>"+escH(c)+"</code>");return "\\x00"+(ci++);});
      s = escH(s);
      s = s.replace(/\\*\\*(.+?)\\*\\*/g,"<strong>$1</strong>");
      s = s.replace(/\\*([^*\\n]+?)\\*/g,"<em>$1</em>");
      s = s.replace(/\\[([^\\]\\n]*)\\]\\((https?:\\/\\/[^)\\n]*)\\)/g,'<a href="$2">$1</a>');
      s = s.replace(/\\x00(\\d+)/g,function(_,i){return ph[+i];});
      return s;
    }
    var lines=src.split("\\n"),out="",para=[],fence=false,fl=[],inL=false,ltag="";
    function fp(){if(!para.length)return;out+="<p>"+para.map(inl).join("<br>")+"</p>";para=[];}
    function fL(){if(!inL)return;out+="</"+ltag+">";inL=false;ltag="";}
    for(var i=0;i<lines.length;i++){
      var ln=lines[i];
      if(ln.slice(0,3)==="\x60\x60\x60"){
        if(!fence){fp();fL();fence=true;fl=[];}
        else{out+="<pre><code>"+escH(fl.join("\\n"))+"</code></pre>";fence=false;}
        continue;
      }
      if(fence){fl.push(ln);continue;}
      var hm=ln.match(/^(#{1,6}) (.*)/);
      if(hm){fp();fL();var hl=hm[1].length;out+="<h"+hl+">"+inl(hm[2])+"</h"+hl+">";continue;}
      if(/^---+\\s*$/.test(ln)){fp();fL();out+="<hr>";continue;}
      if(ln.slice(0,2)==="> "){fp();fL();out+="<blockquote>"+inl(ln.slice(2))+"</blockquote>";continue;}
      var um=ln.match(/^[-*] (.*)/);
      if(um){fp();if(ltag!=="ul"){fL();out+="<ul>";inL=true;ltag="ul";}out+="<li>"+inl(um[1])+"</li>";continue;}
      var om=ln.match(/^\\d+\\. (.*)/);
      if(om){fp();if(ltag!=="ol"){fL();out+="<ol>";inL=true;ltag="ol";}out+="<li>"+inl(om[1])+"</li>";continue;}
      if(!ln.trim()){fp();fL();continue;}
      fL();para.push(ln);
    }
    fp();fL();
    if(fence)out+="<pre><code>"+escH(fl.join("\\n"))+"</code></pre>";
    return out;
  }

  // Handle mobile virtual keyboard resizing
  if (window.visualViewport) {
    var $layout = document.getElementById("layout");
    window.visualViewport.addEventListener("resize", function () {
      $layout.style.height = window.visualViewport.height + "px";
    });
    window.visualViewport.addEventListener("scroll", function () {
      $layout.style.top = window.visualViewport.offsetTop + "px";
    });
  }

  function atBottom() {
    return $msgs.scrollHeight - $msgs.scrollTop - $msgs.clientHeight < 80;
  }

  function scrollDown() { $msgs.scrollTop = $msgs.scrollHeight; }

  function clamp(text, max) {
    if (!text || text.length <= max) return text || "";
    return text.slice(0, max) + "\\n\\u2026(truncated)";
  }

  function buildMsgEl(msg, streaming) {
    var el = document.createElement("div");
    el.dataset.id = msg.id;

    if (msg.role === "user") {
      el.className = "msg msg-user";
      el.innerHTML =
        '<div class="msg-header"><span class="role-label">You</span></div>' +
        '<div class="msg-body">' + esc(msg.text) + '</div>';

    } else if (msg.role === "assistant") {
      el.className = "msg msg-asst" + (streaming ? " msg-streaming" : "");
      var modelTag = msg.model
        ? '<span class="model-tag">' + esc(msg.model.split("/").pop()) + '</span>' : "";
      var html =
        '<div class="msg-header"><span class="role-label">Assistant</span>' + modelTag + '</div>';

      if (msg.text || streaming) {
        html += '<div class="msg-body">' + renderMd(msg.text || "") + '</div>';
      }
      if (msg.toolCalls) {
        msg.toolCalls.forEach(function (tc) {
          html +=
            '<details class="tool-call"><summary>' + esc(tc.name) + '</summary>' +
            '<pre>' + esc(clamp(tc.args, 4000)) + '</pre></details>';
        });
      }
      el.innerHTML = html;

    } else if (msg.role === "tool_result") {
      el.className = "msg msg-tool" + (msg.isError ? " err" : "");
      var icon = msg.isError ? "\u2717" : "\u2713";
      var lbl = esc(msg.toolName || "result");
      el.innerHTML =
        '<div class="msg-header"><span class="role-label">' + icon + " " + lbl + '</span></div>' +
        (msg.text
          ? '<details class="tool-output"><summary>output</summary>' +
            '<div class="msg-body">' + esc(clamp(msg.text, 4000)) + '</div></details>'
          : "");
    }

    return el;
  }

  function renderAll() {
    var snap = atBottom();
    $msgs.innerHTML = "";
    S.msgs.forEach(function (m) { $msgs.appendChild(buildMsgEl(m, false)); });
    if (S.pending) $msgs.appendChild(buildMsgEl(S.pending, true));
    if (snap) scrollDown();
  }

  function updatePending() {
    var snap = atBottom();
    var old = $msgs.querySelector('[data-id="pending"]');
    if (S.pending) {
      var el = buildMsgEl(S.pending, true);
      if (old) $msgs.replaceChild(el, old); else $msgs.appendChild(el);
    } else if (old) {
      old.remove();
    }
    if (snap) scrollDown();
  }

  function renderActiveTools() {
    var entries = Object.values(S.tools);
    $active.innerHTML = entries.length === 0 ? "" : entries.map(function (t) {
      return '<span class="active-tool"><span class="spin">\u27f3</span>' + esc(t.name) + '</span>';
    }).join("");
  }

  function updateStatus(connected) {
    $dot.className = "dot" + (connected ? (S.streaming ? " streaming" : " connected") : "");
    $connLabel.textContent = connected
      ? (S.streaming ? "Agent working\u2026" : "Connected")
      : "Disconnected \u2014 reconnecting\u2026";
    $sendBtn.disabled = !connected;
    if (!connected) $sendBtn.classList.remove("ready");
  }

  var ws, timer;
  function connect() {
    var wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(wsProtocol + "//" + location.host + "/ws");

    ws.onopen = function () {
      clearTimeout(timer);
      updateStatus(true);
    };

    ws.onclose = function () {
      updateStatus(false);
      clearTimeout(timer);
      timer = setTimeout(connect, 2000);
    };
    ws.onerror = function () { ws.close(); };

    ws.onmessage = function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }

      switch (msg.type) {
        case "sync":
          S.msgs      = msg.messages || [];
          S.streaming = !!(msg.state && msg.state.isStreaming);
          S.model     = msg.state && msg.state.model;
          S.pending   = null;
          S.tools     = {};
          renderAll();
          renderActiveTools();
          updateStatus(true);
          break;

        case "message_update":
          S.pending = msg.message;
          updatePending();
          break;

        case "message_end": {
          var snap = atBottom();
          S.msgs.push(msg.message);
          S.pending = null;
          var old = $msgs.querySelector('[data-id="pending"]');
          var newEl = buildMsgEl(msg.message, false);
          if (old) $msgs.replaceChild(newEl, old); else $msgs.appendChild(newEl);
          if (snap) scrollDown();
          break;
        }

        case "tool_start":
          S.tools[msg.toolCallId] = { name: msg.toolName };
          renderActiveTools();
          break;

        case "tool_end":
          delete S.tools[msg.toolCallId];
          renderActiveTools();
          break;

        case "agent_start":
          S.streaming = true;
          updateStatus(true);
          break;

        case "agent_end":
          S.streaming = false;
          S.pending   = null;
          S.tools     = {};
          updatePending();
          renderActiveTools();
          updateStatus(true);
          break;

        case "status":
          updateStatus(true);
          break;
      }
    };
  }

  // Auto-grow textarea
  function autoGrow() {
    $prompt.style.height = "auto";
    $prompt.style.height = Math.min($prompt.scrollHeight, 120) + "px";
    // Toggle send button ready state
    var hasText = $prompt.value.trim().length > 0;
    $sendBtn.classList.toggle("ready", hasText);
  }
  $prompt.addEventListener("input", autoGrow);

  function send() {
    var text = $prompt.value.trim();
    if (!text || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: "prompt", text: text }));
    $prompt.value = "";
    autoGrow();
    // On mobile, dismiss keyboard after sending
    if ("ontouchstart" in window) $prompt.blur();
  }

  $sendBtn.addEventListener("click", send);
  $prompt.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });

  connect();
})();
</script>
</body>
</html>`;
}

// ── HTTP + WebSocket server ──────────────────────────────────────────────────

interface RemoteServer {
	broadcast: (msg: object) => void;
	stop: () => Promise<void>;
	clientCount: () => number;
	onClientChange: (cb: () => void) => void;
	port: number;
	token: string;
}

function startServer(pi: ExtensionAPI, ctx: ExtensionContext): Promise<RemoteServer> {
	const clientChangeListeners: Array<() => void> = [];
	const clients = new Set<any>();
	const token = generateToken();
	// Map of valid session IDs → expiry timestamp (ms since epoch)
	const SESSION_TTL_MS = 86_400_000; // 24 h — matches cookie Max-Age
	const validSessions = new Map<string, number>();
	const pruneExpiredSessions = (): void => {
		const now = Date.now();
		for (const [id, expiresAt] of validSessions) {
			if (expiresAt <= now) validSessions.delete(id);
		}
	};

	/** Check if a request is authenticated (valid token query param OR valid session cookie) */
	function isAuthenticated(req: any): boolean {
		// Check session cookie first
		const cookies = parsecookies(req.headers.cookie);
		const sessionId = cookies[SESSION_COOKIE];
		const sessionExpiry = sessionId ? validSessions.get(sessionId) : undefined;
		if (sessionExpiry !== undefined && sessionExpiry > Date.now()) return true;

		// Check token query param
		const url = new URL(req.url ?? "/", "http://localhost");
		const providedToken = url.searchParams.get("token");
		if (providedToken && validateToken(providedToken, token)) return true;

		return false;
	}

	function broadcast(msg: object): void {
		const data = JSON.stringify(msg);
		for (const client of clients) {
			if (client.readyState === OPEN) {
				try {
					client.send(data);
				} catch {
					/* ignore */
				}
			}
		}
	}

	const httpServer = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const pathname = url.pathname;

		if (pathname === "/" || pathname === "/index.html") {
			// Check authentication
			const cookies = parsecookies(req.headers.cookie);
			const sc = cookies[SESSION_COOKIE];
			const hasValidSession = sc !== undefined && (validSessions.get(sc) ?? 0) > Date.now();
			const providedToken = url.searchParams.get("token");
			const hasValidToken = providedToken && validateToken(providedToken, token);

			if (!hasValidSession && !hasValidToken) {
				res.writeHead(403, { "Content-Type": "text/plain" });
				res.end("Forbidden — valid token required. Use the URL shown in the pi terminal.");
				return;
			}

			// If authenticated via token (first visit), issue a session cookie and redirect to clean URL
			if (!hasValidSession && hasValidToken) {
				pruneExpiredSessions();
				const sessionId = generateSessionId();
				validSessions.set(sessionId, Date.now() + SESSION_TTL_MS);
				res.writeHead(302, {
					"Set-Cookie": `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
					Location: "/",
				});
				res.end();
				return;
			}

			// Valid session cookie — serve the page
			const nonce = randomBytes(16).toString("base64");
			res.writeHead(200, {
				"Content-Type": "text/html; charset=utf-8",
				"X-Frame-Options": "DENY",
				"X-Content-Type-Options": "nosniff",
				"Referrer-Policy": "no-referrer",
				"Content-Security-Policy":
					`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'`,
			});
			res.end(buildHTML(nonce));
		} else {
			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("Not found");
		}
	});

	const wss = new WebSocketServer({ noServer: true });

	httpServer.on("error", (err: Error) => {
		console.error("[remote-control] httpServer error:", err.message);
	});

	wss.on("error", (err: Error) => {
		console.error("[remote-control] wss error:", err.message);
	});

	httpServer.on("upgrade", (request: any, socket: any, head: any) => {
		const url = new URL(request.url, "http://localhost");
		if (url.pathname === "/ws") {
			// Validate auth: session cookie or token query param
			if (!isAuthenticated(request)) {
				socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
				socket.destroy();
				return;
			}
			wss.handleUpgrade(request, socket, head, (ws: any) => {
				wss.emit("connection", ws, request);
			});
		} else {
			socket.destroy();
		}
	});

	wss.on("connection", (ws: any) => {
		clients.add(ws);
		for (const cb of clientChangeListeners) cb();

		// Send full state snapshot to the new client
		try {
			ws.send(
				JSON.stringify({
					type: "sync",
					messages: getBranchMessages(ctx),
					state: {
						isStreaming: !ctx.isIdle(),
						model: ctx.model?.id,
						cwd: ctx.cwd,
						sessionName: ctx.sessionManager.getSessionName(),
					},
				}),
			);
		} catch {
			/* client disconnected before first send */
		}

		// Per-connection rate limiting: max 30 prompts per 60 seconds
		const RATE_WINDOW_MS = 60_000;
		const RATE_MAX = 30;
		const MAX_MSG_BYTES = 64 * 1024;
		const recentPrompts: number[] = [];

		ws.on("message", (data: any) => {
			if (data.length > MAX_MSG_BYTES) return;
			let msg: any;
			try {
				msg = JSON.parse(data.toString());
			} catch {
				return;
			}
			if (msg.type === "prompt" && typeof msg.text === "string" && msg.text.trim()) {
				const text = msg.text.trim();
				// Sliding-window rate limit
				const now = Date.now();
				const cutoff = now - RATE_WINDOW_MS;
				while (recentPrompts.length > 0 && recentPrompts[0] < cutoff) recentPrompts.shift();
				if (recentPrompts.length >= RATE_MAX) return;
				recentPrompts.push(now);
				if (ctx.isIdle()) {
					pi.sendUserMessage(text);
				} else {
					pi.sendUserMessage(text, { deliverAs: "followUp" });
				}
			}
		});

		const onClose = () => {
			clients.delete(ws);
			broadcast({ type: "status", clientCount: clients.size });
			for (const cb of clientChangeListeners) cb();
		};
		ws.on("close", onClose);
		ws.on("error", onClose);
	});

	return new Promise((resolve) => {
		httpServer.listen(0, "127.0.0.1", () => {
			resolve({
				broadcast,
				stop: () =>
					new Promise((res) => {
						for (const client of clients) {
							try {
								client.close();
							} catch {
								/* ignore */
							}
						}
						wss.close(() => httpServer.close(() => res()));
					}),
				clientCount: () => clients.size,
				onClientChange: (cb: () => void) => { clientChangeListeners.push(cb); },
				get port() {
					return (httpServer.address() as any)?.port ?? 0;
				},
				get token() {
					return token;
				},
			});
		});
	});
}

// ── Extension entry point ────────────────────────────────────────────────────

export default function remoteControl(pi: ExtensionAPI) {
	let server: RemoteServer | undefined;

	// ── CLI flag ──────────────────────────────────────────────────────────────

	pi.registerFlag("remote-control", {
		description: "Start the remote-control server automatically on session start",
		type: "boolean",
		default: false,
	});

	// ── Status indicator ──────────────────────────────────────────────────────

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI || !server) return;
		const clients = server.clientCount();
		const label = clients > 0 ? `remote:${clients}` : "remote:on";
		ctx.ui.setStatus("remote-control", ctx.ui.theme.fg("accent", label));
	}

	// ── Lifecycle ──────────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("remote-control") !== true) return;

		const config = await readRemoteControlConfig();
		const publicBaseUrl = config.publicBaseUrl?.trim();
		if (!publicBaseUrl) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"--remote-control: no publicBaseUrl configured. Run /remote-control config first.",
					"warning",
				);
			}
			return;
		}

		server = await startServer(pi, ctx);
		server.onClientChange(() => updateStatus(ctx));
		const url = buildRemoteControlUrl(publicBaseUrl, server.port, server.token);

		if (ctx.hasUI) {
			ctx.ui.notify(`Remote-control started: ${url}`, "info");
		}
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (server) {
			await server.stop();
			server = undefined;
		}
	});

	// ── Event bridge: pi → clients ────────────────────────────────────────────

	pi.on("agent_start", async (_event, ctx) => {
		server?.broadcast({ type: "agent_start" });
		updateStatus(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		server?.broadcast({ type: "agent_end" });
		updateStatus(ctx);
	});

	pi.on("message_update", async (event) => {
		const m = serializeMessage("pending", (event as any).message);
		if (m) server?.broadcast({ type: "message_update", message: m });
	});

	pi.on("message_end", async (event, ctx) => {
		// Use the last branch entry to get the committed entry ID
		const branch = ctx.sessionManager.getBranch();
		const last = branch[branch.length - 1];
		const id = last?.id ?? `msg_${Date.now()}`;
		const m = serializeMessage(id, (event as any).message);
		if (m) server?.broadcast({ type: "message_end", message: m });
	});

	pi.on("tool_execution_start", async (event) => {
		server?.broadcast({
			type: "tool_start",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
		});
	});

	pi.on("tool_execution_end", async (event) => {
		const result = event.result as any;
		const resultText = Array.isArray(result?.content)
			? result.content
					.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("")
			: typeof result === "string"
				? result
				: "";
		server?.broadcast({
			type: "tool_end",
			toolCallId: event.toolCallId,
			result: resultText,
			isError: event.isError,
		});
	});

	// ── /remote-control command ───────────────────────────────────────────────

	pi.registerCommand("remote-control", {
		description: "Start localhost-only remote control server for use behind a port-forwarding proxy",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const subcommand = args.trim().toLowerCase();
			if (subcommand === "config") {
				await configureRemoteControlUI(ctx);
				return;
			}

			const config = await readRemoteControlConfig();
			const publicBaseUrl = config.publicBaseUrl?.trim();
			if (!publicBaseUrl) {
				ctx.ui.notify("Set the public URL first with /remote-control config", "warning");
				return;
			}

			// Start server on first invocation
			if (!server) {
				server = await startServer(pi, ctx);
				server.onClientChange(() => updateStatus(ctx));
				updateStatus(ctx);
			}
			const url = buildRemoteControlUrl(publicBaseUrl, server.port, server.token);

			// Generate QR code
			let qrLines: string[] = [];
			try {
				const qr = execFileSync("qrencode", ["-t", "UTF8", "-m", "1", url], {
					encoding: "utf8",
				}).trimEnd();
				qrLines = qr.split("\n");
			} catch {
				// qrencode not available
			}

			// Show in editor area — press any key to dismiss
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
				container.addChild(new Text(
					theme.fg("accent", theme.bold(" Remote-control")) + theme.fg("dim", "  (Esc/q/Enter to close)"),
					1, 0,
				));
				container.addChild(new Text("\n" + qrLines.map((l) => ` ${l}`).join("\n") + "\n", 1, 0));
				container.addChild(new Text(theme.fg("accent", url), 1, 0));
				container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

				return {
					render: (w) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data) => {
						if (matchesKey(data, Key.escape) || data.toLowerCase() === "q" || matchesKey(data, Key.enter)) done();
					},
				};
			});
		},
	});
}
