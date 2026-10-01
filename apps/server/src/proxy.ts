import { BackendApiError, upstreamFetch } from "@mirror/protocol";
import { EARLY_PATCH } from "./browser-patch.js";
export { injectionCss, injectionJs } from "./mirror-controls.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import { fetchWithAccessTokenFallback, getRequestSessionToken, getRotatedRequestAccessToken, getRotatedRequestSessionToken, getValidCredentials } from "./auth.js";
import { getSession, setSessionAccountId } from "./store.js";
import { isRewritableContentType, requestOrigin, rewriteChatGptUrls } from "./url-rewrite.js";
import { authorizedLocalRequest, isAllowedOrigin, isAllowedRequestHost } from "./security.js";

// Datadog's Browser SDK is configured (on OpenAI's side, in their Datadog
// dashboard) with an "allowed application URLs" list scoped to chatgpt.com --
// it has no awareness of, or way to be told about, a proxy origin like ours,
// so it always logs "SDK initialized on a non-allowed domain" when loaded
// from here and simply refuses to collect anything. There is no client-side
// config we can pass to satisfy that check; it is resolved against Datadog's
// own dashboard settings for the real site, not anything in the page itself.
// Since it never actually collects data through our proxy anyway (and
// proxying our users' session activity to OpenAI's own analytics vendor is
// not something we want regardless), the simplest and most correct fix is to
// strip Datadog's script tags out of the served HTML entirely so the SDK
// never loads and never runs that check in the first place.
// NOTE: an earlier version of this matched any <script> tag whose full text
// (including inline body content) contained "datadog" or "dd_rum". That was
// too broad -- the app's own client-bootstrap script embeds a JSON config
// blob that lists "datadog" among other integration/feature names, so that
// heuristic deleted the real bootstrap script itself, breaking the app with
// "missing client-bootstrap script". Only strip <script src="..."> tags that
// actually point at a Datadog-owned host; never touch inline script bodies.
const DATADOG_SRC_SCRIPT_TAG = /<script\b[^>]*\bsrc=["'][^"']*datadoghq[^"']*["'][^>]*>\s*<\/script>|<script\b[^>]*\bsrc=["'][^"']*datadoghq[^"']*["'][^>]*\/>/gi;
function stripDatadogScripts(html: string): string {
  return html.replace(DATADOG_SRC_SCRIPT_TAG, "");
}

// Disable bundled telemetry initialization. Mirror does not initialize vendor telemetry.
const DATADOG_INIT_CALL_PATTERN = /([$\w]+\.init\(\{applicationId:)/g;
function disableDatadogInit(text: string): string {
  return text.replace(DATADOG_INIT_CALL_PATTERN, "false&&$1");
}

const UPSTREAM = "https://chatgpt.com";
// Kept in sync with a real browser's actual reported version (checked against
// a live HAR capture) rather than left stale -- a User-Agent claiming a much
// older Chrome than what the rest of the request's fingerprint implies is
// itself a mismatch signal, on top of the Node/undici TLS fingerprint always
// being different from a real browser's regardless of what this string says.
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const SEC_CH_UA = '"Chromium";v="152", "Not?A_Brand";v="24", "Google Chrome";v="152"';
// Syntactically valid, unsigned, non-secret JWT. The official client decodes
// expiry/subject locally; the proxy always discards it before upstream calls.
const BROWSER_TOKEN = "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJleHAiOjQxMDI0NDQ4MDAsInN1YiI6Im1pcnJvci11c2VyIn0.";

// Previously this was a static <link>/<script defer> pair spliced directly
// into the served HTML head. That worked, but left extra <head> children
// present during the app's own hydration pass. If the app hydrates starting
// from document/html rather than only the body root, React compares the
// live DOM against what its own server render produced, and nodes we
// injected that it never rendered do not match -- a very plausible cause of
// the hydration RecoverableError (minified React error #418) seen in the
// console even though nothing was actually broken. EARLY_PATCH now creates
// and appends these elements itself after window "load", well after
// hydration has settled, instead of them being present in the initial
// parsed document at all.

/**
 * The upstream bundle bakes absolute `https://chatgpt.com/...` URLs into its
 * fetch/XHR calls instead of using paths relative to the page's own
 * origin. When that HTML is served from our proxy's origin, those calls become
 * real cross-origin requests that chatgpt.com's CORS policy rejects outright
 * (no Access-Control-Allow-Origin for our origin) -- this is NOT fixable with
 * CORS headers on our own server, since our server is never in the loop for
 * those requests at all. Instead we rewrite them back to same-origin, client
 * side, before they're sent, so they hit our proxy (which already forwards
 * any path to upstream) instead of the real chatgpt.com host directly.
 *
 * This MUST run before any of the app's own bundle code does, so it's injected
 * as a blocking (non-deferred, non-async) inline script as the very first
 * thing inside <head> -- earlier than the deferred INJECT script above and
 * earlier than any of the page's own <script> tags, which either come later in
 * the document or are themselves deferred/async/module (which always run
 * after synchronous parsing completes).
 */

function requestBody(req: FastifyRequest): string | Uint8Array | undefined {
  if (req.method === "GET" || req.method === "HEAD" || req.body == null) return undefined;
  if (typeof req.body === "string" || req.body instanceof Uint8Array) return req.body;
  return JSON.stringify(req.body);
}

function safeRequestHeaders(req: FastifyRequest): Headers {
  const headers = new Headers();
  const exact = new Set([
    "accept", "accept-language", "baggage", "cache-control", "content-type",
    "pragma", "priority", "range", "sentry-trace",
    // These are headers a real Chrome attaches to every request automatically
    // (client-hints + fetch metadata) -- forwarding the browser's own values
    // for them, rather than dropping them on the floor, is strictly better
    // than either omitting them or hand-rolling our own guess: it keeps
    // upstream's view consistent with what the actual requesting browser
    // reports (sec-ch-ua's Chrome version, mobile/platform, etc.) instead of
    // introducing a second, independent mismatch on top of the Node/undici
    // TLS fingerprint we can't fix from here anyway.
    "dnt", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform",
    "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-user",
    // Chrome sends "gzip, deflate, br, zstd"; Node's fetch defaults to
    // something narrower (no zstd) if we don't forward this ourselves --
    // another small but checkable mismatch. Safe to forward as-is: undici
    // decompresses the response based on the Content-Encoding it actually
    // gets back, regardless of what we advertised accepting.
    "accept-encoding",
  ]);
  const prefixes = ["chatgpt-", "oai-", "openai-", "x-conduit-", "x-oai-", "x-openai-"];
  for (const [rawName, rawValue] of Object.entries(req.headers)) {
    const name = rawName.toLowerCase();
    if (!exact.has(name) && !prefixes.some((prefix) => name.startsWith(prefix))) continue;
    if (typeof rawValue === "string") headers.set(name, rawValue);
    else if (Array.isArray(rawValue)) headers.set(name, rawValue.join(", "));
  }
  headers.set("user-agent", USER_AGENT);
  // Set origin, host, and referer to match chatgpt.com for proper SSL/TLS origin verification
  headers.set("origin", UPSTREAM);
  headers.set("host", new URL(UPSTREAM).host);
  // A real browser sends a deep, page-specific referer (e.g.
  // https://chatgpt.com/c/<conversation-id>) for API calls made from that
  // conversation's page, not a flat "https://chatgpt.com/" for every single
  // request regardless of context -- always sending the bare origin here was
  // its own small, consistently-checkable tell. Rewrite the browser's own
  // Referer (which points at our proxy origin) back to the real upstream
  // host instead, preserving whatever path it actually had.
  const clientReferer = req.headers.referer;
  if (typeof clientReferer === "string") {
    try {
      const rewritten = new URL(clientReferer);
      const upstreamUrl = new URL(UPSTREAM);
      rewritten.protocol = upstreamUrl.protocol;
      rewritten.hostname = upstreamUrl.hostname;
      rewritten.port = upstreamUrl.port;
      headers.set("referer", rewritten.href);
    } catch {
      headers.set("referer", `${UPSTREAM}/`);
    }
  } else {
    headers.set("referer", `${UPSTREAM}/`);
  }
  // Fall back to our own values only when the browser genuinely didn't send
  // one (e.g. a same-origin GET with no sec-fetch-site, or an older browser
  // without client hints) -- forwarded real values above always win.
  if (!headers.has("sec-ch-ua")) headers.set("sec-ch-ua", SEC_CH_UA);
  if (!headers.has("sec-ch-ua-mobile")) headers.set("sec-ch-ua-mobile", "?0");
  if (!headers.has("sec-ch-ua-platform")) headers.set("sec-ch-ua-platform", '"macOS"');
  return headers;
}

async function upstreamProfile(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text();
  if (!response.ok) throw new BackendApiError("Upstream profile request failed", response.status, body, body);
  try {
    const value = JSON.parse(body);
    if (value && typeof value === "object" && !Array.isArray(value) && value.error == null) return value;
  } catch { /* Preserve the full response below. */ }
  throw new BackendApiError("Upstream profile returned an invalid response", 502, body, body);
}

async function mirrorAuthSession(reply: FastifyReply): Promise<void> {
  const credentials = await getValidCredentials();
  const meResponse = await fetchWithAccessTokenFallback(`${UPSTREAM}/backend-api/me`, {
    headers: {
      accept: "application/json", authorization: `Bearer ${credentials.accessToken}`,
      "oai-device-id": credentials.deviceId, "user-agent": USER_AGENT,
    },
  }, credentials);
  const me = await upstreamProfile(meResponse);
  const account = me.account && typeof me.account === "object" ? me.account as Record<string, unknown> : {};
  reply.header("Cache-Control", "no-store").send({
    user: {
      id: String(account.account_user_id ?? me.id ?? "mirror-user"),
      name: String(me.name ?? account.name ?? "ChatGPT user"),
      email: typeof me.email === "string" ? me.email : null,
      // Upstream profile images can be signed URLs; never reflect their query credentials.
      image: null,
    },
    expires: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    accessToken: BROWSER_TOKEN,
    authProvider: "mirror-session-token",
  });
}

/**
 * Older stored sessions (pre account-id capture) don't have accountId
 * persisted yet. Backfill it lazily from /me on first use so upstream
 * multi-workspace calls (conversations, models) don't silently fall back
 * to a default/limited view.
 */
async function resolveAccountId(credentials: { accessToken: string; deviceId: string }): Promise<string | null> {
  const session = getSession();
  if (session?.accountId) return session.accountId;
  try {
    const meResponse = await fetchWithAccessTokenFallback(`${UPSTREAM}/backend-api/me`, {
      headers: {
        accept: "application/json", authorization: `Bearer ${credentials.accessToken}`,
        "oai-device-id": credentials.deviceId, "user-agent": USER_AGENT,
      },
    }, credentials as import("@mirror/protocol").SessionCredentials);
    const me = await upstreamProfile(meResponse);
    const account = me.account && typeof me.account === "object" ? me.account as Record<string, unknown> : null;
    const orgs = me.orgs && typeof me.orgs === "object" && Array.isArray((me.orgs as Record<string, unknown>).data)
      ? (me.orgs as Record<string, unknown>).data as unknown[] : [];
    let accountId: string | null = null;
    if (account && typeof account.account_user_id === "string") accountId = account.account_user_id;
    else if (orgs.length > 0 && orgs[0] && typeof orgs[0] === "object" && typeof (orgs[0] as Record<string, unknown>).id === "string") {
      accountId = (orgs[0] as Record<string, unknown>).id as string;
    }
    if (accountId) setSessionAccountId(accountId);
    return accountId;
  } catch (error) {
    throw error;
  }
}

export async function proxyChatGpt(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.url.startsWith("/api/auth/session")) return mirrorAuthSession(reply);

  const headers = safeRequestHeaders(req);
  let credentials: import("@mirror/protocol").SessionCredentials | undefined;
  const identityCookies = String(req.headers.cookie ?? "").split(";").map((part) => part.trim())
    .filter((part) => /^(?:oai-client-session-epoch|oai-did)=/.test(part));
  if (identityCookies.length) headers.set("cookie", identityCookies.join("; "));
  // ChatGPT embeds its initial session in the document. A bearer alone cannot
  // authenticate that server-rendered page; use the browser-held session cookie.
  if (((req.method === "GET" && String(req.headers.accept ?? "").includes("text/html")) || req.url.startsWith("/unauth-mweb/")) && getRequestSessionToken()) {
    const pageCredentials = await getValidCredentials();
    const sessionToken = pageCredentials.rotatedSessionToken || pageCredentials.sessionToken;
    if (sessionToken && (pageCredentials.cookie || sessionToken !== pageCredentials.accessToken))
      headers.set("cookie", [...identityCookies, `__Secure-next-auth.session-token=${encodeURIComponent(sessionToken)}`].join("; "));
  }

  // Determine which paths need authentication headers
  const needsAuthHeaders =
    req.url.startsWith("/backend-api/") ||
    req.url.startsWith("/ces/") ||           // Observation/telemetry endpoints
    req.url.startsWith("/api/") ||           // API endpoints (excluding /api/auth/session which is special-cased)
    req.url.startsWith("/realtime/");        // Real-time/Work Mode endpoints
  // Note: /sentinel/* endpoints don't need auth headers (real ChatGPT doesn't send them)

  if (needsAuthHeaders) {
    credentials = await getValidCredentials();
    headers.set("authorization", `Bearer ${credentials.accessToken}`);
    headers.set("oai-device-id", credentials.deviceId);

    // Backend-API specific headers
    if (req.url.startsWith("/backend-api/")) {
      headers.set("x-openai-target-path", req.url.split("?")[0]!);
      headers.set("x-openai-target-route", req.url.split("?")[0]!);
      // The real frontend already sends its own chatgpt-account-id header
      // (safeRequestHeaders forwards it via the "chatgpt-" prefix allowlist)
      // reflecting whatever workspace/org it currently has selected in its own
      // UI state -- unconditionally overwriting that with our once-cached
      // resolveAccountId() value forces every request onto a single account
      // regardless of what the picker/workspace switcher actually shows,
      // which can silently reroute to a different plan/entitlement (and thus a
      // different available model) than the one the UI displays. Only fall
      // back to our resolved id when the frontend didn't send one at all.
      if (!headers.has("chatgpt-account-id") && !req.url.startsWith("/backend-api/me")) {
        const accountId = await resolveAccountId(credentials);
        if (accountId) headers.set("chatgpt-account-id", accountId);
      }
      // resolveAccountId may itself have refreshed an expired accessToken.
      headers.set("authorization", `Bearer ${credentials.accessToken}`);
    }
  }

  let upstream: Response;
  const controller = new AbortController();
  const abortUpstream = () => controller.abort(new DOMException("Proxy client disconnected", "AbortError"));
  req.raw.once("aborted", abortUpstream);
  reply.raw.once("close", () => { if (!reply.raw.writableEnded) abortUpstream(); });

  try {
    const init: RequestInit = {
      method: req.method, headers, body: requestBody(req), redirect: "manual", signal: controller.signal,
    };
    upstream = credentials
      ? await fetchWithAccessTokenFallback(`${UPSTREAM}${req.url}`, init, credentials)
      : await upstreamFetch(`${UPSTREAM}${req.url}`, init);
  } catch (error) {
    req.log.error({ error, path: req.url }, "mirror upstream request failed");
    const details = error as { upstreamResponseText?: unknown; tokenLengths?: unknown; statusCode?: number; message?: string };
    const upstreamResponseText = typeof details?.upstreamResponseText === "string" ? details.upstreamResponseText : undefined;
    const tokenLengths = details?.tokenLengths;
    reply.code(Number(details?.statusCode ?? 502)).send({
      error: {
        type: "upstream_request_failed",
        message: upstreamResponseText ?? details?.message ?? "The upstream request failed before a response was received.",
        ...(upstreamResponseText !== undefined ? { upstream_response_text: upstreamResponseText } : {}),
        ...(tokenLengths !== undefined ? { token_lengths: tokenLengths } : {}),
        path: req.url,
      },
    });
    return;
  }
  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
  const proxyOrigin = requestOrigin(req.protocol, req.headers.host);

  reply.hijack();
  const responseHeaders: Record<string, string | string[]> = {};
  for (const [name, value] of upstream.headers) {
    const lowerName = name.toLowerCase();
    if ([
      "alt-svc", "content-encoding", "content-length", "content-security-policy",
      "content-security-policy-report-only", "nel", "report-to",
      "reporting-endpoints", "set-cookie", "strict-transport-security",
      "transfer-encoding", "x-frame-options",
    ].includes(lowerName)) continue;
    responseHeaders[name] = lowerName === "location" && proxyOrigin
      ? rewriteChatGptUrls(value, proxyOrigin)
      : value;
  }
  const cookie = reply.getHeader("set-cookie");
  if (cookie) responseHeaders["set-cookie"] = String(cookie);
  // The lightweight frontend compares its document identity to this readable
  // epoch cookie. Preserve that marker, without persisting ChatGPT credentials.
  const upstreamCookies = (upstream.headers.getSetCookie?.() ?? [upstream.headers.get("set-cookie") ?? ""])
    .flatMap((value) => value.split(/,(?=\s*[^;,=\s]+=)/)).map((value) => value.trim());
  const identityResponseCookies = upstreamCookies.filter((value) => /^(?:oai-client-session-epoch|oai-did)=/.test(value))
    .map((value) => value.replace(/;\s*Domain=[^;]*/gi, ""));
  if (identityResponseCookies.length) responseHeaders["set-cookie"] = [
    ...(cookie ? [String(cookie)] : []), ...identityResponseCookies,
  ];
  responseHeaders["content-type"] = contentType;
  // Only fall back to a 5-minute public cache for genuinely static assets
  // (CDN-hosted JS/CSS/images) that don't ship their own cache-control from
  // upstream. Applying that same fallback to /backend-api/* responses --
  // the previous behavior -- let the browser cache things like the models
  // list, conversation state, and gizmo sidebar for up to 5 minutes with no
  // way to bust it, which can surface as exactly this kind of "the picker
  // shows one model but a message actually goes to a different one" staleness
  // once the account's available models/config change mid-session. Live API
  // data always defaults to no-store instead unless upstream explicitly
  // opted it into caching.
  //
  // Text content we actually rewrite (html/js/css/json -- rel() URL rewrites,
  // the Datadog allowedTrackingOrigins patch, etc.) is a special case: this
  // is content whose bytes depend on OUR OWN proxy logic, not just on
  // upstream. Upstream ships hashed CDN filenames with a long, effectively
  // "immutable" cache-control (safe on their end, since that filename's
  // upstream bytes truly never change) -- but that same immutable cache-control
  // passing through us verbatim let the browser go on serving an
  // already-fetched, pre-fix copy of a JS chunk for its full max-age even
  // after we deployed a proxy change that alters what we rewrite that exact
  // chunk into. That's exactly why patches to proxied JS content (like the
  // Datadog domain-check patch) didn't visibly take effect in a browser that
  // had already loaded the unpatched version: the cached response was still
  // "fresh" by HTTP rules and never revisited us at all. So for anything we
  // rewrite, force no-store unconditionally instead of only falling back to
  // it -- this overrides upstream's own cache-control rather than deferring
  // to it, unlike every other header in this response.
  const isStaticAsset = req.url.startsWith("/cdn/");
  const isRewrittenText = contentType.includes("text/html") || isRewritableContentType(contentType);
  responseHeaders["cache-control"] = isRewrittenText
    ? "no-store"
    : !isStaticAsset
      ? responseHeaders["cache-control"] ?? "no-store"
      : responseHeaders["cache-control"] ?? "public, max-age=300";
  // Upstream advertises HTTP/3 via Alt-Svc; forwarding that verbatim tricks Chrome into
  // thinking our plain-HTTP proxy origin also speaks QUIC/h3, causing later requests to
  // fail with net::ERR_ALPN_NEGOTIATION_FAILED when it tries (and fails) to negotiate that
  // protocol. Explicitly sending "clear" (RFC 7838 §4) also purges any such entry the
  // browser already cached from before this fix.
  responseHeaders["alt-svc"] = "clear";
  const accessToken = await getRotatedRequestAccessToken();
  if (accessToken) {
    responseHeaders["x-mirror-access-token"] = accessToken;
    responseHeaders["cache-control"] = "no-store";
  }
  const sessionToken = await getRotatedRequestSessionToken();
  if (sessionToken) responseHeaders["x-mirror-session-token"] = sessionToken;
  reply.raw.writeHead(upstream.status, responseHeaders);

  // Error payloads are diagnostic evidence from the upstream. Preserve the
  // status, content type, and exact text instead of rewriting HTML/JSON or
  // injecting browser patches into an error response.
  if (!upstream.ok) {
    reply.raw.end(await upstream.text());
    return;
  }

  if (contentType.includes("text/html")) {
    let html = await upstream.text();
    // Rewrite the upstream document before injecting EARLY_PATCH. The injected
    // shim intentionally still names the real upstream origin so it can catch
    // dynamically constructed URLs that were not present in the HTML source.
    if (proxyOrigin) html = rewriteChatGptUrls(html, proxyOrigin);
    html = stripDatadogScripts(html);
    html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (tag) => `${tag}${EARLY_PATCH}`) : `${EARLY_PATCH}${html}`;
    reply.raw.end(html);
    return;
  }

  // This is the important worker/module fix. Rewriting only window.fetch is
  // insufficient because worker globals have their own fetch/Request objects.
  // By rewriting JS/JSON/CSS/etc. while proxying the asset, all execution
  // contexts receive same-origin endpoints and therefore route back through
  // this server (which attaches credentials and forwards to ChatGPT).
  if (proxyOrigin && isRewritableContentType(contentType)) {
    let text = rewriteChatGptUrls(await upstream.text(), proxyOrigin);
    text = disableDatadogInit(text);
    reply.raw.end(text);
    return;
  }

  if (!upstream.body) { reply.raw.end(); return; }
  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (reply.raw.destroyed) break;
      if (!reply.raw.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => {
          const finish = () => { reply.raw.off("drain", finish); reply.raw.off("close", finish); resolve(); };
          reply.raw.once("drain", finish);
          reply.raw.once("close", finish);
        });
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    if (!reply.raw.destroyed) reply.raw.end();
  }
}
