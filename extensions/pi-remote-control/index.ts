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

import { createRequire } from "node:module";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, keyHint } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import {
	readRemoteControlConfig,
	buildRemoteControlUrl,
	configureRemoteControlUI,
} from "./config.js";
import { serializeMessage } from "./messages.js";
import { type RemoteServer, startServer } from "./server.js";

// ── Extension entry point ────────────────────────────────────────────────────

const _require = createRequire(import.meta.url);
const QRCode = _require("qrcode") as { toString: (text: string, opts: any) => Promise<string> };

export default function remoteControl(pi: ExtensionAPI) {
	let server: RemoteServer | undefined;
	let pendingSyncTimer: ReturnType<typeof setTimeout> | undefined;

	function scheduleSync(ctx: ExtensionContext): void {
		if (pendingSyncTimer) clearTimeout(pendingSyncTimer);
		pendingSyncTimer = setTimeout(() => {
			pendingSyncTimer = undefined;
			server?.sync(ctx);
			updateStatus(ctx);
		}, 0);
	}

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

	pi.on("session_switch", async (_event, ctx) => {
		scheduleSync(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		scheduleSync(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (pendingSyncTimer) {
			clearTimeout(pendingSyncTimer);
			pendingSyncTimer = undefined;
		}
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

	async function showConnectionInfo(ctx: ExtensionContext): Promise<void> {
		if (!server) return;

		const config = await readRemoteControlConfig();
		const publicBaseUrl = config.publicBaseUrl?.trim();
		if (!publicBaseUrl) return;

		const url = buildRemoteControlUrl(publicBaseUrl, server.port, server.token);

		// Generate QR code
		let qrLines: string[] = [];
		try {
			const qr = await QRCode.toString(url, { type: "utf8", margin: 2 });
			qrLines = qr.trimEnd().split("\n");
		} catch {
			// QR code generation failed
		}

		// Show in editor area — use confirm/cancel to dismiss
		await ctx.ui.custom<void>((_tui, theme, kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
			container.addChild(new Text(
				theme.fg("accent", theme.bold(" Remote-control")) +
					"  " +
					keyHint("tui.select.confirm", "close") +
					theme.fg("muted", " · ") +
					keyHint("tui.select.cancel", "cancel"),
				1, 0,
			));
			container.addChild(new Text("\n" + qrLines.map((l) => ` ${l}`).join("\n") + "\n", 1, 0));
			container.addChild(new Text(theme.fg("accent", url), 1, 0));
			container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

			return {
				render: (w) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data) => {
					if (kb.matches(data, "tui.select.cancel") || kb.matches(data, "tui.select.confirm")) done();
				},
			};
		});
	}

	pi.registerCommand("remote-control", {
		description: "Remote control — start/stop server, configure, show connection info",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;

			const isRunning = !!server;
			const config = await readRemoteControlConfig();
			const currentUrl = config.publicBaseUrl?.trim();

			const configLabel = currentUrl ? `Configure URL (${currentUrl})` : "Configure URL (not set)";
			const menuItems = [
				isRunning ? "Turn off" : "Turn on",
				configLabel,
				...(isRunning ? ["Status"] : []),
			];

			const choice = await ctx.ui.select("Remote control", menuItems);
			if (choice === undefined) return;

			if (choice === "Turn on") {
				const publicBaseUrl = currentUrl;
				if (!publicBaseUrl) {
					ctx.ui.notify("Set the public URL first — opening config…", "warning");
					await configureRemoteControlUI(ctx);
					// Re-check after config
					const updated = await readRemoteControlConfig();
					if (!updated.publicBaseUrl?.trim()) return;
				}
				server = await startServer(pi, ctx);
				server.onClientChange(() => updateStatus(ctx));
				updateStatus(ctx);
				ctx.ui.notify("Remote-control server started", "info");
				await showConnectionInfo(ctx);
			} else if (choice === "Turn off") {
				if (server) {
					await server.stop();
					server = undefined;
					ctx.ui.setStatus("remote-control", undefined);
					ctx.ui.notify("Remote-control server stopped", "info");
				}
			} else if (choice === configLabel) {
				await configureRemoteControlUI(ctx);
			} else if (choice === "Status") {
				await showConnectionInfo(ctx);
			}
		},
	});
}
