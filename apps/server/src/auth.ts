import { upstreamFetch } from "@mirror/protocol";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  isAccessDeniedResponse,
  mintAccessTokenShared,
  SessionTokenInvalidError,
  type SessionCredentials,
} from "@mirror/protocol";
import { getOrCreateDeviceId } from "./store.js";

interface RequestAuthentication {
  bearerToken: string;
  sessionToken?: string;
  credentials?: Promise<SessionCredentials>;
}

const requestAuthentication = new AsyncLocalStorage<RequestAuthentication>();

/** Make the browser-provided bearer available only for this request. */
export function setRequestSessionToken(token: string, sessionToken?: string): void {
  if (token && (requestAuthentication.getStore()?.bearerToken !== token || requestAuthentication.getStore()?.sessionToken !== sessionToken))
    requestAuthentication.enterWith({ bearerToken: token, sessionToken });
}

export function runWithRequestSessionToken<T>(token: string | undefined, callback: () => T, sessionToken?: string): T {
  return token ? requestAuthentication.run({ bearerToken: token, sessionToken }, callback) : callback();
}

/** Compatibility name retained for existing call sites; this is now the client-held bearer. */
export function getRequestSessionToken(): string | undefined {
  return requestAuthentication.getStore()?.bearerToken;
}

export function getRequestFallbackSessionToken(): string | undefined {
  return requestAuthentication.getStore()?.sessionToken;
}

/** Return the supplied bearer unchanged: it may already be an accessToken. */
export async function getValidCredentials(): Promise<SessionCredentials> {
  const request = requestAuthentication.getStore();
  if (!request?.bearerToken) {
    const err = new Error("Supply a ChatGPT accessToken or sessionToken as a Bearer credential.");
    (err as any).statusCode = 401;
    throw err;
  }
  request.credentials ??= Promise.resolve({
    accessToken: request.bearerToken,
    sessionToken: request.sessionToken || request.bearerToken,
    deviceId: getOrCreateDeviceId(),
  });
  return request.credentials;
}

/** Newly minted access tokens are returned for the browser to store. */
export async function getRotatedRequestAccessToken(): Promise<string | undefined> {
  const request = requestAuthentication.getStore();
  if (!request?.credentials) return undefined;
  const credentials = await request.credentials;
  return credentials.accessToken !== request.bearerToken ? credentials.accessToken : undefined;
}

export async function getRotatedRequestSessionToken(): Promise<string | undefined> {
  const request = requestAuthentication.getStore();
  if (!request?.credentials) return undefined;
  const credentials = await request.credentials;
  return credentials.rotatedSessionToken || undefined;
}

/** Use an accessToken first, then exchange the same original bearer after a clear auth denial. */
export async function fetchWithAccessTokenFallback(
  input: string | URL | Request,
  init: RequestInit,
  credentials: SessionCredentials,
): Promise<Response> {
  const first = await upstreamFetch(input, init);
  if (!credentials.sessionToken || !await isAccessDeniedResponse(first)) return first;
  const minted = await mintAccessTokenShared(credentials.sessionToken).catch((error) => {
    if (error && typeof error === "object") {
      Object.assign(error, {
        tokenLengths: {
          accessToken: { received: credentials.accessToken.length, sentUpstream: credentials.accessToken.length },
          sessionToken: { received: credentials.sessionToken!.length, sentUpstream: credentials.sessionToken!.length },
        },
      });
    }
    if (error instanceof SessionTokenInvalidError) (error as any).statusCode = 401;
    throw error;
  });
  credentials.accessToken = minted.accessToken;
  credentials.rotatedSessionToken = minted.rotatedSessionToken;
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${minted.accessToken}`);
  await first.body?.cancel().catch(() => {});
  return upstreamFetch(input, { ...init, headers });
}
