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

const requestAuthentication = new AsyncLocalStorage<RequestAuthentication>();
const activeMints = new Map<string, ReturnType<typeof mintAccessToken>>();

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
      const minted = await mintShared(request.sessionToken);
      request.rotatedSessionToken = minted.rotatedSessionToken ?? undefined;
      return {
        accessToken: minted.accessToken,
        deviceId: getOrCreateDeviceId(),
        sessionToken: minted.rotatedSessionToken ?? request.sessionToken,
      };
    } catch (err) {
      if (err instanceof SessionTokenInvalidError) (err as any).statusCode = 401;
      throw err;
    }
  })();
  return request.credentials;
}
