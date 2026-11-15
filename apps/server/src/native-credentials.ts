import type { FastifyReply, FastifyRequest } from "fastify";
import { createBrowserCredentials } from "@mirror/protocol";
import { getRotatedRequestAccessToken, getRotatedRequestSessionToken } from "./auth.js";

const nativeReads = new WeakMap<FastifyRequest, [string, string]>();
function readNativePair(req: FastifyRequest, enabled: boolean, readOnly = false, requireSameOrigin = false): [string, string] | undefined {
  if (!enabled || (readOnly && !["GET", "HEAD"].includes(req.method))) return;
  const fetchSite = String(req.headers["sec-fetch-site"] || "");
  if (fetchSite && !["same-origin", "none"].includes(fetchSite)) return;
  const requestOrigin = new URL(`${req.protocol}://${req.headers.host}`).origin;
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  if (origin && origin !== requestOrigin) return;
  if (requireSameOrigin && fetchSite !== "same-origin" && origin !== requestOrigin) return;
  const pair = createBrowserCredentials(undefined, { read: () => req.headers.cookie || "", write: String }).readCookie();
  if (!pair || pair === "rejected") return;
  return pair;
}

export function nativeReadCredentials(req: FastifyRequest, enabled: boolean): [string, string] | undefined {
  if (req.headers.authorization) return;
  const pair = readNativePair(req, enabled, true);
  if (!pair) return;
  nativeReads.set(req, pair);
  return pair;
}

/** Use the same-origin browser credential cookie as a refresh fallback only
 * when its saved access token matches the explicit bearer on this request. */
export function nativeSessionFallback(req: FastifyRequest, bearer: string): string | undefined {
  if (!bearer) return;
  // Mutating browser requests cannot safely carry a custom session header:
  // XHR follows redirects. Only use the host-only cookie as a renewal hint
  // after a strict same-origin check and only for the exact supplied bearer.
  const pair = readNativePair(req, true, false, true);
  return pair?.[0] === bearer ? pair[1] || undefined : undefined;
}

/** Must run before proxy/SSE hijack as well as ordinary Fastify onSend. */
export async function applyNativeCredentialCookies(reply: FastifyReply): Promise<boolean> {
  const pair = nativeReads.get(reply.request);
  if (!pair) return false;
  const status = reply.getHeader("x-mirror-auth-status");
  const output: string[] = [];
  const jar = createBrowserCredentials(undefined, { read: () => reply.request.headers.cookie || "", write: value => output.push(value) });
  if (status === "credential_rejected" || status === "owner_mismatch") jar.rejectCookie();
  else if (status === "owner_verified") {
    const access = await getRotatedRequestAccessToken(), session = await getRotatedRequestSessionToken();
    if (access || session) jar.rotateCookie([access || pair[0], session || pair[1] || (access && access !== pair[0] ? pair[0] : "")]);
  }
  if (output.length) {
    const existing = reply.getHeader("set-cookie");
    reply.header("set-cookie", [...(existing ? Array.isArray(existing) ? existing.map(String) : [String(existing)] : []), ...output]);
    reply.header("cache-control", "no-store");
  }
  return true;
}
