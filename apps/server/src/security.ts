import { randomBytes, timingSafeEqual } from "node:crypto";
const cloudflareRuntime = typeof (globalThis as typeof globalThis & { WebSocketPair?: unknown }).WebSocketPair !== "undefined";

function isIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function hostnameFromHost(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname
      .replace(/^\[|\]$/g, "")
      .toLowerCase();
  } catch {
    return null;
  }
}

export function configuredApiKeys(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [env.MIRROR_API_KEY, ...(env.MIRROR_API_KEYS ?? "").split(","), env.OPENAI_API_KEY]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    (isIpv4(normalized) && normalized.startsWith("127."))
  );
}

function extraAllowedHostnames(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  // DEMO-ONLY escape hatch: lets a specific external hostname (e.g. a
  // localtunnel/ngrok URL used to record a demo GIF) through the
  // loopback-only Host check below. Unset/empty by default, so normal
  // deployments keep the DNS-rebinding protection fully intact. Never
  // leave this set for anything but a short-lived, throwaway demo.
  return (env.MIRROR_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowedRequestHost(
  host: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!host) return false;
  const hostname = hostnameFromHost(host);
  if (!hostname) return false;
  if (cloudflareRuntime) return true;
  if (isLoopbackHostname(hostname)) return true;
  return extraAllowedHostnames(env).includes(hostname);
}

export function isAllowedOrigin(
  origin: string | undefined,
  requestHost: string | undefined,
): boolean {
  if (!origin) return true; // Non-browser clients do not normally send Origin.
  try {
    const originUrl = new URL(origin);
    const requestHostname = requestHost ? hostnameFromHost(requestHost) : null;
    if (requestHostname && originUrl.host.toLowerCase() === requestHost?.toLowerCase() && ["http:", "https:"].includes(originUrl.protocol)) return true;
    const developmentOrigin =
      process.env.MIRROR_WEB_ORIGIN?.trim() || "http://localhost:5173";
    return originUrl.origin === new URL(developmentOrigin).origin;
  } catch {
    return false;
  }
}

export function tokenMatches(candidate: string, accepted: string[]): boolean {
  const candidateBytes = Buffer.from(candidate);
  return accepted.some((token) => {
    const tokenBytes = Buffer.from(token);
    return (
      tokenBytes.length === candidateBytes.length &&
      timingSafeEqual(tokenBytes, candidateBytes)
    );
  });
}

export function bearerToken(authorization: string | undefined): string {
  return authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
}

let controlSecret: string | undefined;
function getControlSecret(): string {
  controlSecret ??= randomBytes(32).toString("base64url");
  return controlSecret;
}
export function controlCookie(): string { return `mirror_control=${getControlSecret()}; Path=/; HttpOnly; SameSite=Strict${cloudflareRuntime ? "; Secure" : ""}`; }
export function authorizedLocalRequest(headers: { authorization?: string; cookie?: string }): boolean {
  if (tokenMatches(bearerToken(headers.authorization), configuredApiKeys())) return true;
  const cookie = headers.cookie?.split(";").map(x => x.trim()).find(x => x.startsWith("mirror_control="))?.slice(15) ?? "";
  return tokenMatches(cookie, controlSecret ? [controlSecret] : []);
}
export function mayBootstrapBrowser(method: string, url: string, headers: Record<string, unknown>, publicShell = false): boolean {
  if (publicShell) {
    // The proxy serves an open-ended set of frontend routes (including /space).
    // Classify browser document intent, not a second, incomplete route table.
    // This grants only the credential-free shell; its fetch still passes the
    // owner gate. Keep Node's control-cookie bootstrap separate below.
    if (method !== "GET" || !url.startsWith("/") || url.startsWith("//")) return false;
    let pathname: string;
    try { pathname = decodeURIComponent(url.split("?", 1)[0]!); } catch { return false; }
    if (pathname.startsWith("//") || /[\\\x00-\x1f]/.test(pathname) || pathname.includes("://")) return false;
    pathname = new URL(pathname, "https://mirror.invalid").pathname;
    if (/^\/(?:api|backend-api|__codex-api|v1|ces|realtime|sentinel|cdn|_next|assets)(?:\/|$)/i.test(pathname) ||
      /^\/(?:mirror\/assets|unauth-mweb\/(?:assets|scripts))(?:\/|$)/i.test(pathname) ||
      /\.(?:data|json|js|mjs|css|map|wasm|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|txt|xml|webmanifest)$/i.test(pathname) || pathname === "/index.html") return false;
    const query = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    const accept = String(headers.accept ?? "").toLowerCase();
    if (headers.rsc === "1" || accept.includes("text/x-component") || query.has("_rsc") || query.has("_data")) return false;
    const mode = headers["sec-fetch-mode"], destination = headers["sec-fetch-dest"];
    if (mode !== undefined || destination !== undefined) return mode === "navigate" && destination === "document";
    // Older browsers/WebViews may omit Fetch Metadata, including on Android.
    return accept.includes("text/html");
  }
  const pathname = url.split("?", 1)[0];
  const isBrowserPage = pathname === "/" || pathname === "/mirror/playground" || pathname === "/mirror/api-docs" ||
    /^\/c\/[a-z0-9:_-]+\/?$/i.test(pathname) ||
    /^\/g\/g-[a-z0-9_-]+(?:\/c\/[a-z0-9:_-]+|\/project)?\/?$/i.test(pathname);
  return method === "GET" && isBrowserPage &&
    String(headers.accept ?? "").includes("text/html") && headers["sec-fetch-site"] !== "cross-site";
}
