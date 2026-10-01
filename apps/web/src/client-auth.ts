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

/** Every same-origin Mirror request reads the current credentials from browser storage. */
export async function mirrorFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (url.origin !== location.origin) return globalThis.fetch(input, init);
  const bearer = readStoredBearer();
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);
  // This is a Mirror-only transport header. The server maps it to ChatGPT's
  // session cookie; ChatGPT's Bearer value remains the access token.
  const sessionToken = readStoredSessionToken();
  headers.delete("x-mirror-session-token");
  if (sessionToken) headers.set("x-mirror-session-token", sessionToken);
  const response = await globalThis.fetch(input, { ...init, headers });
  const accessToken = response.headers.get("x-mirror-access-token");
  const rotatedSessionToken = response.headers.get("x-mirror-session-token");
  try {
    if (accessToken) storeAccessToken(accessToken, bearer, rotatedSessionToken);
    else if (rotatedSessionToken) {
      localStorage.setItem(SESSION_TOKEN_KEY, rotatedSessionToken);
      if (bearer) storeAccessToken(bearer);
    }
  } catch { /* The request still succeeds when browser storage is unavailable. */ }
  return response;
}
