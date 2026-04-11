/**
 * Configuration management for remote-control.
 *
 * Reads/writes the `remote-control.json` config file from the agent directory,
 * and provides the UI flow for configuring the public base URL.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

const REMOTE_CONTROL_CONFIG_FILE = "remote-control.json";

export type TransportMode = "surge" | "tailscale";

export interface RemoteControlConfig {
	publicBaseUrl?: string;
	transport?: TransportMode;
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

export async function readRemoteControlConfig(): Promise<RemoteControlConfig> {
	try {
		const raw = await fs.readFile(getRemoteControlConfigPath(), "utf8");
		const parsed = JSON.parse(raw) as RemoteControlConfig;
		if (!parsed || typeof parsed !== "object") return {};
		return parsed;
	} catch {
		return {};
	}
}

export async function writeRemoteControlConfig(config: RemoteControlConfig): Promise<void> {
	const configPath = getRemoteControlConfigPath();
	await fs.mkdir(path.dirname(configPath), { recursive: true });
	await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

export function normalizePublicBaseUrl(value: string): string {
	const parsed = new URL(value.trim());
	parsed.username = "";
	parsed.password = "";
	parsed.pathname = "";
	parsed.search = "";
	parsed.hash = "";
	return parsed.toString().replace(/\/+$/, "");
}

export function buildRemoteControlUrl(publicBaseUrl: string, port: number, token: string): string {
	const parsed = new URL(normalizePublicBaseUrl(publicBaseUrl));
	if (parsed.protocol === "http:") {
		parsed.port = String(port);
	}
	parsed.searchParams.set("token", token);
	return parsed.toString();
}

export async function configureRemoteControlUI(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;

	const current = (await readRemoteControlConfig()).publicBaseUrl ?? "";
	const title = current
		? `Public base URL (current: ${current})`
		: "Public base URL";
	const raw = await ctx.ui.input(title, "e.g. http://pi.myhost");
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

// ── Tailscale helpers ────────────────────────────────────────────────────────

/**
 * Detect whether tailscale is installed and running on this machine.
 * Returns the Tailscale IPv4 address, or null if tailscale is not available.
 */
export async function detectTailscaleIp(): Promise<string | null> {
	// Method 1: tailscale CLI
	const { execSync } = await import("node:child_process");
	try {
		const ip = execSync("tailscale ip -4", { encoding: "utf8", timeout: 5000 }).trim();
		if (ip && /^100\.\d+\.\d+\.\d+$/.test(ip)) return ip;
	} catch {
		// tailscale CLI not available or not logged in
	}

	// Method 2: Tailscale local API (HTTP on 100.100.100.100)
	const http = await import("node:http");
	return new Promise((resolve) => {
		const req = http.get(
			"http://100.100.100.100:9090/localapi/v0/status",
			{ timeout: 3000 },
			(res) => {
				let body = "";
				res.on("data", (chunk) => (body += chunk));
				res.on("end", () => {
					try {
						const status = JSON.parse(body);
						const self = status.Self;
						if (self?.TailscaleIPs?.length > 0) {
							const ip4 = self.TailscaleIPs.find((ip: string) => ip.startsWith("100."));
							if (ip4) { resolve(ip4); return; }
						}
					} catch { /* parse error */ }
					resolve(null);
				});
			},
		);
		req.on("error", () => resolve(null));
		req.on("timeout", () => { req.destroy(); resolve(null); });
	});
}

export async function isTailscaleRunning(): Promise<boolean> {
	return (await detectTailscaleIp()) !== null;
}
