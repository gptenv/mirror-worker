import { upstreamFetch } from "@mirror/protocol";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  isAccessDeniedResponse,
  mintAccessTokenShared,
  SessionTokenInvalidError,
  type SessionCredentials,
} from "@mirror/protocol";
import { getOrCreateDeviceId } from "./store.js";
import { configuredApiKeys, tokenMatches } from "./security.js";

interface RequestAuthentication {
  bearerToken: string;
  sessionToken?: string;
  credentials?: Promise<SessionCredentials>;
  configuredTokens?: string[];
  initialAccessToken?: string;
}

const requestAuthentication = new AsyncLocalStorage<RequestAuthentication>();

/** Make the browser-provided bearer available only for this request. */
export function setRequestSessionToken(token: string, sessionToken?: string): void {
  if (token && (requestAuthentication.getStore()?.bearerToken !== token || requestAuthentication.getStore()?.sessionToken !== sessionToken))
    requestAuthentication.enterWith({ bearerToken: token, sessionToken, configuredTokens: requestAuthentication.getStore()?.configuredTokens });
}

export function runWithRequestSessionToken<T>(token: string | undefined, callback: () => T, sessionToken?: string, configuredTokens?: string[]): T {
  return token || configuredTokens?.length ? requestAuthentication.run({ bearerToken: token ?? "", sessionToken, configuredTokens }, callback) : callback();
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
  const configuredTokens = request?.configuredTokens ?? configuredApiKeys();
  // A configured inbound key selects the first configured ChatGPT token.
  // Unrecognized bearers authenticate with their own credential, so they cannot
  // gain access to the configured account merely by sending an arbitrary key.
  const configuredToken = !request?.bearerToken || tokenMatches(request.bearerToken, configuredTokens)
    ? configuredTokens[0] : undefined;
  const accessToken = configuredToken || request?.bearerToken;
  const sessionToken = configuredToken || request?.sessionToken || request?.bearerToken;
  if (!accessToken) {
    const err = new Error("Supply a ChatGPT accessToken or sessionToken as a Bearer credential.");
    (err as any).statusCode = 401;
    throw err;
  }
  const credentials = () => Promise.resolve({
    accessToken,
    sessionToken,
    ...(sessionToken ? { cookie: `__Secure-next-auth.session-token=${encodeURIComponent(sessionToken)}` } : {}),
    deviceId: getOrCreateDeviceId(),
  });
  if (!request) return credentials();
  request.initialAccessToken ??= accessToken;
  request.credentials ??= credentials();
  return request.credentials;
}

/** Newly minted access tokens are returned for the browser to store. */
export async function getRotatedRequestAccessToken(): Promise<string | undefined> {
  const request = requestAuthentication.getStore();
  if (!request?.credentials) return undefined;
  const credentials = await request.credentials;
  return credentials.accessToken !== (request.initialAccessToken ?? request.bearerToken) ? credentials.accessToken : undefined;
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
  const requestHeaders = new Headers(init.headers);
  if (credentials.cookie) {
    const otherCookies = (requestHeaders.get("cookie") ?? "").split(";").map(value => value.trim())
      .filter(value => value && !value.startsWith("__Secure-next-auth.session-token="));
    requestHeaders.set("cookie", [...otherCookies, credentials.cookie].join("; "));
  }
  init = { ...init, headers: requestHeaders };
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
  if (minted.rotatedSessionToken) credentials.sessionToken = minted.rotatedSessionToken;
  credentials.cookie = `__Secure-next-auth.session-token=${encodeURIComponent(minted.rotatedSessionToken || credentials.sessionToken)}`;
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${minted.accessToken}`);
  headers.set("cookie", credentials.cookie);
  await first.body?.cancel().catch(() => {});
  return upstreamFetch(input, { ...init, headers });
}
