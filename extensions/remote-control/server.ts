/**
 * HTTP + WebSocket server for remote-control.
 *
 * Handles authentication, serves the web UI, and manages WebSocket connections
 * for real-time message streaming between the pi session and browser clients.
 */

import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo, Socket } from "node:net";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  generateSessionId,
  generateToken,
  parseCookies,
  SESSION_COOKIE,
  validateToken,
} from "./auth.js";
import { buildHTML } from "./html.js";
import { buildSyncMessage } from "./messages.js";

interface WsClient {
  readyState: number;
  send(data: string): void;
  terminate(): void;
  on(event: "message", listener: (data: Buffer) => void): void;
  on(event: "close" | "error", listener: () => void): void;
}

interface WsServer {
  on(event: "connection", listener: (ws: WsClient) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  handleUpgrade(
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
    cb: (ws: WsClient) => void,
  ): void;
  emit(event: string, ...args: unknown[]): void;
  close(cb?: () => void): void;
}

// Load ws (bundled with pi) without needing @types/ws installed locally
const _require = createRequire(import.meta.url);
const wsModule = _require("ws") as {
  WebSocketServer: new (opts: { noServer: boolean }) => WsServer;
  OPEN: number;
};
const { WebSocketServer, OPEN } = wsModule;

export interface RemoteServer {
  broadcast: (msg: object) => void;
  sync: (ctx: ExtensionContext) => void;
  stop: () => Promise<void>;
  clientCount: () => number;
  onClientChange: (cb: () => void) => void;
  port: number;
  token: string;
}

export function startServer(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<RemoteServer> {
  const clientChangeListeners: Array<() => void> = [];
  const clients = new Set<WsClient>();
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
  function isAuthenticated(req: IncomingMessage): boolean {
    // Check session cookie first
    const cookies = parseCookies(req.headers.cookie);
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

  function sync(currentCtx: ExtensionContext): void {
    broadcast(buildSyncMessage(currentCtx));
  }

  const httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    if (pathname === "/" || pathname === "/index.html") {
      // Check authentication
      const cookies = parseCookies(req.headers.cookie);
      const sc = cookies[SESSION_COOKIE];
      const hasValidSession =
        sc !== undefined && (validSessions.get(sc) ?? 0) > Date.now();
      const providedToken = url.searchParams.get("token");
      const hasValidToken =
        providedToken && validateToken(providedToken, token);

      if (!hasValidSession && !hasValidToken) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(
          "Forbidden — valid token required. Use the URL shown in the pi terminal.",
        );
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
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'`,
      });
      res.end(buildHTML(nonce));
    } else {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
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

  httpServer.on(
    "upgrade",
    (request: IncomingMessage, socket: Socket, head: Buffer) => {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname === "/ws") {
        // Validate auth: session cookie or token query param
        if (!isAuthenticated(request)) {
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          socket.destroy();
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws: WsClient) => {
          wss.emit("connection", ws, request);
        });
      } else {
        socket.destroy();
      }
    },
  );

  wss.on("connection", (ws: WsClient) => {
    clients.add(ws);
    for (const cb of clientChangeListeners) cb();

    // Send full state snapshot to the new client
    try {
      ws.send(JSON.stringify(buildSyncMessage(ctx)));
    } catch {
      /* client disconnected before first send */
    }

    // Per-connection rate limiting: max 30 prompts per 60 seconds
    const RATE_WINDOW_MS = 60_000;
    const RATE_MAX = 30;
    const MAX_MSG_BYTES = 64 * 1024;
    const recentPrompts: number[] = [];

    ws.on("message", (data: Buffer) => {
      if (data.length > MAX_MSG_BYTES) return;
      let msg: { type?: string; text?: string };
      try {
        const parsed: unknown = JSON.parse(data.toString());
        if (typeof parsed !== "object" || parsed === null) return;
        msg = parsed as { type?: string; text?: string };
      } catch {
        return;
      }
      if (msg.type === "stop") {
        if (!ctx.isIdle()) {
          ctx.abort();
        }
        return;
      }
      if (
        msg.type === "prompt" &&
        typeof msg.text === "string" &&
        msg.text.trim()
      ) {
        const text = msg.text.trim();
        // Sliding-window rate limit
        const now = Date.now();
        const cutoff = now - RATE_WINDOW_MS;
        while (recentPrompts.length > 0 && recentPrompts[0] < cutoff)
          recentPrompts.shift();
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
        sync,
        stop: () =>
          new Promise<void>((res) => {
            // Forcefully kill all WebSocket clients — terminate() sends no
            // close frame and doesn't wait for the remote end to acknowledge,
            // so it can't hang on an unresponsive client.
            for (const client of clients) {
              try {
                client.terminate();
              } catch {
                /* ignore */
              }
            }
            clients.clear();

            // Safety timeout — if wss/http shutdown callbacks never fire
            // (e.g. lingering keep-alive sockets), resolve anyway so the
            // session_shutdown handler doesn't block pi from exiting.
            const timeout = setTimeout(() => {
              httpServer.close(() => {});
              httpServer.closeAllConnections?.();
              res();
            }, 2000);

            wss.close(() =>
              httpServer.close(() => {
                clearTimeout(timeout);
                res();
              }),
            );
          }),
        clientCount: () => clients.size,
        onClientChange: (cb: () => void) => {
          clientChangeListeners.push(cb);
        },
        get port() {
          return (httpServer.address() as AddressInfo | null)?.port ?? 0;
        },
        get token() {
          return token;
        },
      });
    });
  });
}
