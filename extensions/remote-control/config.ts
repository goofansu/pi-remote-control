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

export interface RemoteControlConfig {
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

async function writeRemoteControlConfig(config: RemoteControlConfig): Promise<void> {
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
