const ACCESS_TOKEN_KEY = "mirror_access_token";
const SESSION_TOKEN_KEY = "mirror_session_token";

export function readStoredBearer(): string {
  try { return localStorage.getItem(ACCESS_TOKEN_KEY) || localStorage.getItem(SESSION_TOKEN_KEY) || ""; }
  catch { return ""; }
}
export function readStoredSessionToken(): string {
  try { return localStorage.getItem(SESSION_TOKEN_KEY) || ""; } catch { return ""; }
}
export function storeAccessToken(token: string, previousBearer?: string, rotatedSessionToken?: string | null): void {
  if (rotatedSessionToken) localStorage.setItem(SESSION_TOKEN_KEY, rotatedSessionToken);
  else if (previousBearer && previousBearer !== token && !readStoredSessionToken())
    localStorage.setItem(SESSION_TOKEN_KEY, previousBearer);
  localStorage.setItem(ACCESS_TOKEN_KEY, token);
  document.cookie = `mirror_asset_session=${encodeURIComponent(readStoredSessionToken() || token)}; Path=/api/asset-content; SameSite=Strict${location.protocol === "https:" ? "; Secure" : ""}`;
}

/** Invalid/credential-bearing URLs are never usable endpoints. */
export function endpointOrigin(endpoint: string): string | null {
  try {
    const url = new URL(endpoint);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}

export function endpointHeaders(endpoint: string, externalKey = ""): Headers {
  const origin = endpointOrigin(endpoint);
  if (!origin) throw new Error("Enter a valid HTTP(S) server URL without embedded credentials.");
  const headers = new Headers();
  const bearer = origin === location.origin ? readStoredBearer() : externalKey;
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);
  if (origin === location.origin) {
    const session = readStoredSessionToken();
    if (session) headers.set("x-mirror-session-token", session);
  }
  return headers;
}

/** Native downloads cannot attach Bearer credentials; fetch before navigating. */
export async function downloadAuthenticated(url: string, filename: string): Promise<void> {
  if (new URL(url, location.href).origin !== location.origin) throw new Error("Downloads must use this Mirror origin.");
  const response = await mirrorFetch(url);
  if (!response.ok) throw new Error(await response.text());
  const objectUrl = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.append(link);
  try { link.click(); }
  finally { link.remove(); setTimeout(() => URL.revokeObjectURL(objectUrl), 1000); }
}

/** Every same-origin Mirror request reads the current credentials from browser storage. */
export async function mirrorFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (url.origin !== location.origin) {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.delete("x-mirror-session-token");
    const suppliedBearer = headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if ([readStoredBearer(), readStoredSessionToken()].some(token => token && suppliedBearer === token))
      headers.delete("authorization");
    return globalThis.fetch(input, { ...init, headers, credentials: "omit", redirect: "error" });
  }
  const bearer = readStoredBearer();
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);
  // This is a Mirror-only transport header. The server maps it to ChatGPT's
  // session cookie; ChatGPT's Bearer value remains the access token.
  const sessionToken = readStoredSessionToken();
  headers.delete("x-mirror-session-token");
  if (sessionToken) headers.set("x-mirror-session-token", sessionToken);
  const response = await globalThis.fetch(input, { ...init, headers, redirect: "error" });
  const accessToken = response.headers.get("x-mirror-access-token");
  const rotatedSessionToken = response.headers.get("x-mirror-session-token");
  try {
    // An in-flight response belongs to the credentials it was sent with. A
    // manual change, logout, or newer rotation must not be undone by it.
    if (readStoredBearer() !== bearer || readStoredSessionToken() !== sessionToken) return response;
    if (accessToken) storeAccessToken(accessToken, bearer, rotatedSessionToken);
    else if (rotatedSessionToken) {
      localStorage.setItem(SESSION_TOKEN_KEY, rotatedSessionToken);
      if (bearer) storeAccessToken(bearer);
    }
  } catch { /* The request still succeeds when browser storage is unavailable. */ }
  return response;
}
