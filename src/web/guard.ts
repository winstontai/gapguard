const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export interface RequestGuardInput {
  method: string;
  host: string | undefined;
  origin: string | undefined;
  /** Value of the X-Gap-Guard header. */
  guardHeader: string | undefined;
  remoteAddress: string | undefined;
  port: number;
}

export type GuardResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * The dashboard can sign transactions, so it has to survive a malicious page in the user's own
 * browser, not just a remote attacker:
 * - the socket must be loopback, so nothing off-box reaches it
 * - Host must name loopback, which defeats DNS rebinding (the attacker's domain would appear here)
 * - Origin, whenever the browser sends one, must be this dashboard
 * - anything mutating must carry X-Gap-Guard. A cross-origin page can only set that header by
 *   triggering a CORS preflight, which this server never approves. Without it, a "simple" POST
 *   (text/plain body, no preflight) from any website would silently run a hedge.
 */
export function checkRequest(input: RequestGuardInput): GuardResult {
  if (!input.remoteAddress || !LOOPBACK_ADDRESSES.has(input.remoteAddress)) {
    return { ok: false, status: 403, error: "dashboard is local-only" };
  }

  const host = input.host?.toLowerCase();
  const allowedHosts = new Set([`127.0.0.1:${input.port}`, `localhost:${input.port}`, `[::1]:${input.port}`]);
  if (!host || !allowedHosts.has(host)) {
    return { ok: false, status: 403, error: "unexpected Host header" };
  }

  if (input.origin !== undefined) {
    const allowedOrigins = new Set([
      `http://127.0.0.1:${input.port}`,
      `http://localhost:${input.port}`,
      `http://[::1]:${input.port}`,
    ]);
    if (!allowedOrigins.has(input.origin.toLowerCase())) {
      return { ok: false, status: 403, error: "cross-origin requests are refused" };
    }
  }

  if (input.method !== "GET" && input.method !== "HEAD" && input.guardHeader !== "1") {
    return { ok: false, status: 403, error: "missing X-Gap-Guard header" };
  }

  return { ok: true };
}
