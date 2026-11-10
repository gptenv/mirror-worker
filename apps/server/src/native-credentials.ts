import type { FastifyReply, FastifyRequest } from "fastify";
import { createBrowserCredentials } from "@mirror/protocol";
import { getRotatedRequestAccessToken, getRotatedRequestSessionToken } from "./auth.js";

const nativeReads = new WeakMap<FastifyRequest, [string, string]>();
export function nativeReadCredentials(req: FastifyRequest, enabled: boolean): [string, string] | undefined {
  if (!enabled || !["GET", "HEAD"].includes(req.method) || req.headers.authorization) return;
  if (req.headers["sec-fetch-site"] && !["same-origin", "none"].includes(String(req.headers["sec-fetch-site"]))) return;
  if (req.headers.origin && req.headers.origin !== `${req.protocol}://${req.headers.host}`) return;
  const pair = createBrowserCredentials(undefined, { read: () => req.headers.cookie || "", write: String }).readCookie();
  if (!pair || pair === "rejected") return;
  nativeReads.set(req, pair);
  return pair;
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
