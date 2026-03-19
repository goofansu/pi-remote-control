/**
 * Inline web UI for remote-control.
 *
 * Generates the single-page HTML/CSS/JS served to the browser client.
 * Everything is self-contained — no external dependencies.
 */

export function buildHTML(nonce: string): string {
return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, interactive-widget=resizes-content">
  <title>π - remote-control</title>
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
    #send-btn.stop {
      background: var(--tool-err);
      color: #fff;
    }
    #send-btn.stop:active { transform: scale(0.9); }
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
    #send-btn .icon-stop {
      display: none;
      width: 14px;
      height: 14px;
      background: #fff;
      border-radius: 2px;
    }
    #send-btn.stop svg { display: none; }
    #send-btn.stop .icon-stop { display: block; }

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
    <button id="send-btn" disabled aria-label="Send"><svg viewBox="0 0 24 24"><path d="M3.4 20.4l17.45-7.48a1 1 0 000-1.84L3.4 3.6a.993.993 0 00-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z"/></svg><div class="icon-stop"></div></button>
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
    var lines=src.split("\\n"),out="",para=[],fence=false,fl=[],inL=false,ltag="",tbl=[];
    function fp(){if(!para.length)return;out+="<p>"+para.map(inl).join("<br>")+"</p>";para=[];}
    function fL(){if(!inL)return;out+="</"+ltag+">";inL=false;ltag="";}
    function fT(){
      if(!tbl.length)return;
      if(tbl.length<2||!/^[|\\s:\\-]+$/.test(tbl[1])){tbl.forEach(function(r){para.push(r);});tbl=[];return;}
      var hdr=tbl[0].replace(/^\\|/,"").replace(/\\|$/,"").split("|");
      out+="<table><thead><tr>";hdr.forEach(function(c){out+="<th>"+inl(c.trim())+"</th>";});
      out+="</tr></thead><tbody>";
      for(var j=2;j<tbl.length;j++){var cells=tbl[j].replace(/^\\|/,"").replace(/\\|$/,"").split("|");out+="<tr>";cells.forEach(function(c){out+="<td>"+inl(c.trim())+"</td>";});out+="</tr>";}
      out+="</tbody></table>";tbl=[];
    }
    for(var i=0;i<lines.length;i++){
      var ln=lines[i];
      if(ln.slice(0,3)==="\x60\x60\x60"){
        if(!fence){fp();fL();fence=true;fl=[];}
        else{out+="<pre><code>"+escH(fl.join("\\n"))+"</code></pre>";fence=false;}
        continue;
      }
      if(fence){fl.push(ln);continue;}
      if(ln.charAt(0)==="|"){fp();fL();tbl.push(ln);continue;}
      if(tbl.length){fT();}
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
    fp();fL();fT();
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
    if (!connected) {
      $sendBtn.classList.remove("ready");
      $sendBtn.classList.remove("stop");
    }
    updateSendBtn();
  }

  function updateSendBtn() {
    if (!ws || ws.readyState !== 1) return;
    var hasText = $prompt.value.trim().length > 0;
    if (S.streaming) {
      $sendBtn.classList.add("stop");
      $sendBtn.classList.remove("ready");
      $sendBtn.disabled = false;
      $sendBtn.setAttribute("aria-label", "Stop");
    } else {
      $sendBtn.classList.remove("stop");
      $sendBtn.classList.toggle("ready", hasText);
      $sendBtn.setAttribute("aria-label", "Send");
    }
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
    updateSendBtn();
  }
  $prompt.addEventListener("input", autoGrow);

  function send() {
    if (!ws || ws.readyState !== 1) return;
    if (S.streaming) {
      ws.send(JSON.stringify({ type: "stop" }));
      return;
    }
    var text = $prompt.value.trim();
    if (!text) return;
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
