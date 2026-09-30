import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  mintAccessToken,
  SessionTokenInvalidError,
  type SessionCredentials,
} from "@mirror/protocol";
import { getOrCreateDeviceId } from "./store.js";

interface RequestAuthentication {
  sessionToken: string;
  credentials?: Promise<SessionCredentials>;
  rotatedSessionToken?: string;
}

interface CachedAccessToken {
  accessToken: string;
  expiresAt: number;
  deviceId: string;
}

const requestAuthentication = new AsyncLocalStorage<RequestAuthentication>();
const activeMints = new Map<string, ReturnType<typeof mintAccessToken>>();
const cachedAccessTokens = new Map<string, CachedAccessToken>();
const REFRESH_BUFFER_MS = 60_000;

function sessionTokenKey(sessionToken: string): string {
  return createHash("sha256").update(sessionToken).digest("hex");
}

function cacheAccessToken(sessionToken: string, cached: CachedAccessToken): void {
  const now = Date.now();
  for (const [key, entry] of cachedAccessTokens) {
    if (entry.expiresAt - now < REFRESH_BUFFER_MS) cachedAccessTokens.delete(key);
  }
  cachedAccessTokens.set(sessionTokenKey(sessionToken), cached);
  // The upstream may rotate the browser-held session cookie during a mint.
  // Cache against both token hashes so the following request can reuse this
  // access token without persisting either session-token value.
  if (cachedAccessTokens.size > 16) {
    const oldest = cachedAccessTokens.keys().next().value;
    if (oldest) cachedAccessTokens.delete(oldest);
  }
}

/** Share concurrent rotations so parallel browser requests do not race one cookie value. */
function mintShared(sessionToken: string): ReturnType<typeof mintAccessToken> {
  const key = createHash("sha256").update(sessionToken).digest("hex");
  const active = activeMints.get(key);
  if (active) return active;
  let pending: ReturnType<typeof mintAccessToken>;
  pending = mintAccessToken(sessionToken).finally(() => {
    if (activeMints.get(key) === pending) activeMints.delete(key);
  });
  activeMints.set(key, pending);
  return pending;
}

/** Make an incoming browser/API bearer available only for this request. */
export function setRequestSessionToken(token: string): void {
  if (token && requestAuthentication.getStore()?.sessionToken !== token)
    requestAuthentication.enterWith({ sessionToken: token });
}

export function runWithRequestSessionToken<T>(token: string | undefined, callback: () => T): T {
  return token ? requestAuthentication.run({ sessionToken: token }, callback) : callback();
}

export function getRotatedRequestSessionToken(): string | undefined {
  return requestAuthentication.getStore()?.rotatedSessionToken;
}

export function getRequestSessionToken(): string | undefined {
  return requestAuthentication.getStore()?.sessionToken;
}

/** Mint once per request. Neither the input nor minted credentials are persisted. */
export async function getValidCredentials(): Promise<SessionCredentials> {
  const request = requestAuthentication.getStore();
  if (!request?.sessionToken) {
    const err = new Error("Supply your ChatGPT session token as a Bearer credential.");
    (err as any).statusCode = 401;
    throw err;
  }
  request.credentials ??= (async () => {
    try {
      const key = sessionTokenKey(request.sessionToken);
      const cached = cachedAccessTokens.get(key);
      if (cached && cached.expiresAt - Date.now() >= REFRESH_BUFFER_MS) {
        return {
          accessToken: cached.accessToken,
          deviceId: cached.deviceId,
          sessionToken: request.sessionToken,
        };
      }
      const minted = await mintShared(request.sessionToken);
      request.rotatedSessionToken = minted.rotatedSessionToken ?? undefined;
      const credentials = {
        accessToken: minted.accessToken,
        deviceId: getOrCreateDeviceId(),
        sessionToken: minted.rotatedSessionToken ?? request.sessionToken,
      };
      const cachedCredentials = {
        accessToken: credentials.accessToken,
        expiresAt: minted.expiresAt,
        deviceId: credentials.deviceId,
      };
      cacheAccessToken(request.sessionToken, cachedCredentials);
      if (minted.rotatedSessionToken)
        cacheAccessToken(minted.rotatedSessionToken, cachedCredentials);
      return credentials;
    } catch (err) {
      if (err instanceof SessionTokenInvalidError) (err as any).statusCode = 401;
      throw err;
    }
  })();
  return request.credentials;
}
