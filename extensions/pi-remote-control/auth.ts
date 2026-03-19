/**
 * Authentication helpers for remote-control.
 *
 * Provides one-time token generation/validation and session cookie management.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

export function generateToken(): string {
	return randomBytes(24).toString("base64url"); // 32 chars, URL-safe
}

export function validateToken(provided: string, expected: string): boolean {
	const a = Buffer.from(provided);
	const b = Buffer.from(expected);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/** Name of the cookie that grants access after initial token validation */
export const SESSION_COOKIE = "pi_rc_session";

export function generateSessionId(): string {
	return randomBytes(24).toString("base64url");
}

export function parseCookies(header: string | undefined): Record<string, string> {
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
