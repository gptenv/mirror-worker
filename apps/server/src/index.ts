import { registerInsightRoutes } from "./insights.js";
import { registerDecoderChallengeRoutes } from "./decoder-challenges.js";
import { registerConversionRoutes } from "./conversion-routes.js";
import { uploadMimeType } from "./upload-mime.js";
import { registerAssetContentRoute } from "./asset-content.js";
import { apiError, recordFailure } from "./api-errors.js";
import { formatStartupFailure } from "./preflight.js";
import { syncConversationPage, hasRemoteHistory } from "./conversation-sync.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Fastify, { type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { stringify as toYaml } from "yaml";
import { z, ZodError } from "zod";
import { buildOpenApiDocument } from "./openapi-document.js";
import {
  ConversationIdParam,
  ModelUpdateBody,
  BranchBody,
  NewConversationBody,
  ConversationsQuery,
  AssetsQuery,
  ChatBody,
} from "./api-schemas.js";
import {
  ChatGptBackendClient,
  normalizeGizmos,
  normalizeModels,
  type NormalizedConversationEvent,
} from "@mirror/protocol";
import { getRequestSessionToken, getRotatedRequestSessionToken, getValidCredentials, setRequestSessionToken } from "./auth.js";
import { runChat, stopConversation } from "./chat-service.js";
import { registerOpenAiRoutes } from "./openai.js";
import {
  injectionCss,
  injectionJs,
  proxyChatGpt,
} from "./proxy.js";
import {
  getEgressStatus,
} from "./egress.js";
import {
  controlCookie,
  authorizedLocalRequest,
  mayBootstrapBrowser,
  bearerToken,
  configuredApiKeys,
  isAllowedOrigin,
  isAllowedRequestHost,
  tokenMatches,
} from "./security.js";
import {
  getSessionRevision,
  assertSessionRevision,
  getInstructions,
  branchConversation,
  claimDefaultAccountData,
  clearSession,
  countConversations,
  createConversation,
  databaseHealthy,
  deleteConversation,
  getConversation,
  getConversationSyncCursor,
  getSession,
  importRemoteConversation,
  listConversations,
  listMessages,
  saveFile,
  saveVerifiedSession,
  setConversationModel,
  setConversationSyncCursor,
  syncRemoteConversations,
  ownsFile,
  ownsUpstreamConversation,
} from "./store.js";


function isPublicApiPath(url: string): boolean {
  const pathname = url.split("?", 1)[0];
  return pathname === "/v1/responses" || pathname === "/v1/models" || pathname === "/v1/chat/completions" || pathname === "/v1/capabilities";
}

export interface WorkerAssets {
  fetch(request: Request): Promise<Response>;
}

export async function buildApp(options: { worker?: boolean; assets?: WorkerAssets } = {}) {
const app = Fastify({
  trustProxy: options.worker ? true : false,
  logger: options.worker ? false : {
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.body.sessionToken",
    ],
    serializers: {
      // Signed realtime/AJAX URLs can carry short-lived credentials in their
      // query string. Keep request logging useful without persisting them.
      req(req) {
        return {
          method: req.method,
          url: typeof req.url === "string" ? req.url.split("?", 1)[0] : req.url,
          host: req.headers?.host,
          remoteAddress: req.socket?.remoteAddress,
          remotePort: req.socket?.remotePort,
        };
      },
    },
  },
  bodyLimit: 30 * 1024 * 1024,
});
await app.register(cors, {
  delegator: async (req: FastifyRequest) => ({
    // API clients authenticate with explicit bearer keys, not ambient cookies.
    // Preflight has no key; the actual request is authenticated below.
    origin: isAllowedRequestHost(req.headers.host) &&
      (isPublicApiPath(req.url) || isAllowedOrigin(req.headers.origin, req.headers.host))
      ? (req.headers.origin || false) : false,
    credentials: false,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "x-mirror-device-id", "x-turnstile-token"],
    exposedHeaders: ["x-mirror-conversation-id", "x-request-id", "x-mirror-session-token"],
  }),
});
await app.register(rateLimit, {
  global: true,
  max: 180,
  timeWindow: "1 minute",
});
await app.register(multipart, {
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

const accountKey = () => getSession()?.accountId ?? "default";
app.addHook("onRequest", async (req, reply) => {
  reply.header("x-request-id", req.id);
  if (!isAllowedRequestHost(req.headers.host)) {
    return reply.code(421).send({ error: "Untrusted Host header" });
  }
  const bearer = bearerToken(req.headers.authorization);
  const isConfiguredApiKey = tokenMatches(bearer, configuredApiKeys());
  const assetContentRequest = ["GET", "HEAD"].includes(req.method) && req.url.split("?", 1)[0] === "/api/asset-content";
  const encodedAssetCookieToken = assetContentRequest
    ? req.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("mirror_asset_session="))?.slice("mirror_asset_session=".length)
    : undefined;
  let assetCookieToken: string | undefined;
  try { assetCookieToken = encodedAssetCookieToken ? decodeURIComponent(encodedAssetCookieToken) : undefined; } catch { assetCookieToken = undefined; }
  let sessionBearerAuthenticated = false;
  const requiresUpstreamSession = isPublicApiPath(req.url) ||
    req.url.startsWith("/backend-api/") || req.url.startsWith("/ces/") ||
    req.url.startsWith("/realtime/") || req.url.startsWith("/api/auth/") ||
    req.url.split("?", 1)[0] === "/api/session" || assetContentRequest;
  const requestSessionToken = bearer || assetCookieToken || "";
  if (requestSessionToken) setRequestSessionToken(requestSessionToken);
  if (requestSessionToken && requiresUpstreamSession) {
    // A ChatGPT session token is the client-side Mirror bearer credential.
    // Verify it before granting access to local routes, and reuse the minted
    // token for the rest of this request.
    try {
      await getValidCredentials();
      sessionBearerAuthenticated = true;
    } catch (error) {
      return reply.code(Number((error as { statusCode?: number }).statusCode ?? 401)).send({
        error: { message: "Invalid ChatGPT session token", type: "authentication_error" },
      });
    }
  }
  // Native image/download requests use a client-side cookie scoped only to
  // this exact asset route because browsers cannot attach Authorization.
  if (assetContentRequest) {
    if (!sessionBearerAuthenticated) return reply.code(401).send({ error: "A valid session token is required for this asset." });
    return;
  }
  const crossOriginPublicApi = isPublicApiPath(req.url) && !isAllowedOrigin(req.headers.origin, req.headers.host);
  if (crossOriginPublicApi) {
    if (!isConfiguredApiKey && !sessionBearerAuthenticated) {
      return reply.code(401).send({ error: {
        message: "Cross-origin API requests require a ChatGPT session token Bearer credential",
        type: "authentication_error",
      } });
    }
  }
  const authenticatedCrossOriginApi = crossOriginPublicApi && (isConfiguredApiKey || sessionBearerAuthenticated);
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  if (mutating && !isAllowedOrigin(req.headers.origin, req.headers.host) && !authenticatedCrossOriginApi) {
    return reply
      .code(403)
      .send({ error: "Cross-origin control request rejected" });
  }
  if (req.headers.origin && !isAllowedOrigin(req.headers.origin, req.headers.host) && !authenticatedCrossOriginApi)
    return reply.code(403).send({error: "Origin rejected"});
  const workerPage = options.worker && req.method === "GET" &&
    ["/mirror/playground", "/mirror/api-docs", "/mirror/openapi"].includes(req.url.split("?", 1)[0]!) &&
    String(req.headers.accept ?? "").includes("text/html");
  const workerAsset = options.worker && req.method === "GET" &&
    (/^\/(?:assets|mirror\/assets)\//.test(req.url) || ["/favicon.ico", "/index.html"].includes(req.url.split("?", 1)[0]!));
  if (workerPage || workerAsset) return;
  if (!options.worker && mayBootstrapBrowser(req.method, req.url, req.headers)) {
    req.log.info({ url: req.url }, "setting control cookie for bootstrap");
    reply.header("Set-Cookie", controlCookie());
    return;
  }
  if (req.url === "/api/health" || req.url.startsWith("/mirror/assets/")) return;
  if (!sessionBearerAuthenticated && !authorizedLocalRequest(req.headers) && bearer && !isConfiguredApiKey) {
    try {
      await getValidCredentials();
      sessionBearerAuthenticated = true;
    } catch (error) {
      return reply.code(Number((error as { statusCode?: number }).statusCode ?? 401)).send({
        error: { message: "Invalid ChatGPT session token", type: "authentication_error" },
      });
    }
  }
  if (!sessionBearerAuthenticated && !authorizedLocalRequest(req.headers)) {
    return reply.code(401).send({ error: { message: "Open Mirror in your browser or supply a ChatGPT session token as the Bearer credential", type: "authentication_error" } });
  }
});

app.addHook("onSend", async (req, reply, payload) => {
  const rotatedSessionToken = getRotatedRequestSessionToken();
  if (rotatedSessionToken) {
    reply.header("x-mirror-session-token", rotatedSessionToken);
    if (req.url.split("?", 1)[0] === "/api/asset-content") {
      const secure = req.protocol === "https" ? "; Secure" : "";
      reply.header("Set-Cookie", `mirror_asset_session=${encodeURIComponent(rotatedSessionToken)}; Path=/api/asset-content; SameSite=Strict${secure}`);
    }
  }
  if (req.url.startsWith("/v1/") && reply.statusCode >= 400) {
    // Format direct route replies and Fastify/plugin failures alike. Every
    // /v1/ response - a route's own .send(), the notFoundHandler, the rate
    // limiter, and setErrorHandler above - is JSON, and Fastify's default
    // serializer has already turned it into a string by the time onSend
    // hooks run; likewise, every /v1/ error object this app itself
    // produces is shaped one of two ways: a bare string, or an object
    // with a .message (see openai.ts, insights.ts, and setErrorHandler).
    const parsed = JSON.parse(payload as string);
    const message = typeof parsed.error === "string" ? parsed.error : parsed.error.message;
    const envelope = apiError(reply.statusCode, message, req.id);
    recordFailure(envelope.error.code, req.id);
    return JSON.stringify(envelope);
  }
  return payload;
});

app.setErrorHandler((error, _req, reply) => {
  const status =
    error instanceof ZodError
      ? 400
      : Number((error as { statusCode?: number }).statusCode ?? 500);
  const message =
    error instanceof ZodError
      ? error.issues.map((issue) => issue.message).join("; ")
      : status >= 500
        ? "Internal server error"
        : error instanceof Error
          ? error.message
          : "Request failed";
  if (status >= 500) app.log.error({ err: error }, "request failed");
  reply.code(status).send({ error: message });
});

app.get("/api/health", async () => ({
  ok:
    databaseHealthy() &&
    (!getEgressStatus().required || getEgressStatus().verified),
  storage: "sqlite",
  configured: Boolean(getSession()),
  egress: getEgressStatus(),
}));

app.post("/api/session", async (req, reply) => {
  const credentials = await getValidCredentials();
  const client = new ChatGptBackendClient(credentials);
  const me = await client.fetchMe();
  saveVerifiedSession(
    client.accountId ?? undefined,
    credentials.deviceId,
  );
  if (client.accountId) claimDefaultAccountData(client.accountId);
  reply.header("Cache-Control", "no-store");
  return {
    ok: true,
    accountId: client.accountId,
    email: typeof me.email === "string" ? me.email : null,
  };
});

app.get("/api/session", async () => {
  const session = getSession();
  return {
    configured: Boolean(getRequestSessionToken()),
    savedAt: session?.savedAt ?? null,
    hasTurnstileToken: Boolean(session?.turnstileToken),
  };
});
app.delete("/api/session", async () => {
  clearSession();
  return { ok: true };
});

app.get("/api/models", async () => {
  const client = new ChatGptBackendClient(await getValidCredentials());
  return normalizeModels(await client.fetchModels()).map(
    ({ raw: _raw, ...model }) => model,
  );
});
app.get("/api/gpts", async () => {
  const client = new ChatGptBackendClient(await getValidCredentials());
  const [projects, gpts] = await Promise.all([
    client
      .fetchGizmoSidebar({
        ownedOnly: false,
        limit: 50,
        conversationsPerGizmo: 0,
      })
      .catch(() => ({})),
    client.fetchGizmoBootstrap({ limit: 20 }).catch(() => ({})),
  ]);
  const seen = new Set<string>();
  return [...normalizeGizmos(gpts), ...normalizeGizmos(projects)]
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .map(({ raw: _raw, ...gizmo }) => gizmo);
});

// Paginated so a UI (the Playground's "Load a conversation" list) can lazy
// load a large history as the user scrolls, instead of eagerly fetching
// every page of it up front. The full remote-sidebar sync - which walks
// every page of the real ChatGPT sidebar via fetchConversations, an O(total
// conversation count) series of upstream calls - only makes sense to redo
// on the *first* page of a fresh listing (or an explicit refresh); repeating
// it on every subsequent scroll-triggered page would turn "scroll down" into
// "re-fetch your entire ChatGPT history" on every scroll tick, so callers
// paging past offset 0 pass sync=false and get served straight from the
// local mirror of it instead.
app.get("/api/conversations", async (req) => {
  const { limit, offset, sync, resync } = ConversationsQuery.parse(req.query);
  if (sync) {
    const revision = getSessionRevision();
    const accountId = accountKey();
    const client = new ChatGptBackendClient(await getValidCredentials());
    assertSessionRevision(revision);
    await syncConversationPage(accountId, offset + limit, resync, async (options) => {
      assertSessionRevision(revision);
      const page = await client.fetchConversations(options);
      assertSessionRevision(revision);
      return page;
    });
  }
  const items = listConversations(accountKey(), { limit, offset });
  const total = countConversations(accountKey());
  return { items, total, hasMore: offset + items.length < total || hasRemoteHistory(accountKey()) };
});
app.post("/api/conversations", async (req) =>
  createConversation({
    ...NewConversationBody.parse(req.body),
    accountId: accountKey(),
  }),
);
app.get("/api/conversations/:id", async (req, reply) => {
  // Mirror conversation ids are UUIDs when auto-generated, but a caller can
  // also name their own via /v1/chat/completions' metadata.conversation_id
  // (e.g. an arbitrary slug) - accept any non-empty id here so a
  // Playground/API-driven conversation created that way can still be
  // browsed, loaded, and managed through these routes.
  const { id } = ConversationIdParam.parse(req.params);
  let conversation = getConversation(id);
  if (conversation?.accountId !== accountKey())
    return reply.code(404).send({ error: "Conversation not found" });
  if (conversation.conversationId && listMessages(id).length === 0) {
    const client = new ChatGptBackendClient(await getValidCredentials());
    conversation = importRemoteConversation(
      id,
      await client.fetchConversation(conversation.conversationId),
    );
  }
  return { conversation, messages: listMessages(id), instructions: getInstructions(id) };
});
app.patch("/api/conversations/:id", async (req, reply) => {
  // Mirror conversation ids are UUIDs when auto-generated, but a caller can
  // also name their own via /v1/chat/completions' metadata.conversation_id
  // (e.g. an arbitrary slug) - accept any non-empty id here so a
  // Playground/API-driven conversation created that way can still be
  // browsed, loaded, and managed through these routes.
  const { id } = ConversationIdParam.parse(req.params);
  if (getConversation(id)?.accountId !== accountKey())
    return reply.code(404).send({ error: "Conversation not found" });
  return setConversationModel(id, ModelUpdateBody.parse(req.body).model);
});
app.delete("/api/conversations/:id", async (req) => {
  // Mirror conversation ids are UUIDs when auto-generated, but a caller can
  // also name their own via /v1/chat/completions' metadata.conversation_id
  // (e.g. an arbitrary slug) - accept any non-empty id here so a
  // Playground/API-driven conversation created that way can still be
  // browsed, loaded, and managed through these routes.
  const { id } = ConversationIdParam.parse(req.params);
  if (getConversation(id)?.accountId !== accountKey()) return { ok: false };
  stopConversation(id);
  deleteConversation(id);
  return { ok: true };
});
app.post("/api/conversations/:id/stop", async (req, reply) => {
  // Mirror conversation ids are UUIDs when auto-generated, but a caller can
  // also name their own via /v1/chat/completions' metadata.conversation_id
  // (e.g. an arbitrary slug) - accept any non-empty id here so a
  // Playground/API-driven conversation created that way can still be
  // browsed, loaded, and managed through these routes.
  const { id } = ConversationIdParam.parse(req.params);
  if (getConversation(id)?.accountId !== accountKey())
    return reply.code(404).send({ error: "Conversation not found" });
  return { ok: stopConversation(id) };
});
app.post("/api/conversations/:id/branch", async (req, reply) => {
  // Mirror conversation ids are UUIDs when auto-generated, but a caller can
  // also name their own via /v1/chat/completions' metadata.conversation_id
  // (e.g. an arbitrary slug) - accept any non-empty id here so a
  // Playground/API-driven conversation created that way can still be
  // browsed, loaded, and managed through these routes.
  const { id } = ConversationIdParam.parse(req.params);
  if (getConversation(id)?.accountId !== accountKey())
    return reply.code(404).send({ error: "Conversation not found" });
  const body = BranchBody.parse(req.body);
  const target = listMessages(id).find(
    (message) => message.id === body.messageId && message.upstreamNodeId,
  );
  if (!target?.upstreamNodeId)
    return reply
      .code(400)
      .send({ error: "That message cannot be used as a branch point" });
  return branchConversation(
    id,
    target.upstreamNodeId,
    body.title,
    body.messageId,
  );
});

app.post("/api/files", async (req, reply) => {
  const part = await req.file();
  if (!part) return reply.code(400).send({ error: "No file uploaded" });
  const data = await part.toBuffer();
  const client = new ChatGptBackendClient(await getValidCredentials());
  await client.fetchMe().catch(() => undefined);
  const file = await client.uploadFile({
    data,
    fileName: part.filename,
    mimeType: uploadMimeType(part.filename),
  });
  const publicFile = { ...file, raw: {} };
  saveFile(publicFile, accountKey());
  return publicFile;
});

app.get("/api/assets", async (req, reply) => {
  const query = AssetsQuery.parse(req.query);
  if (
    !query.pointer.startsWith("file-service://") &&
    !query.pointer.startsWith("sediment://")
  ) {
    return reply.code(400).send({ error: "Unsupported asset pointer" });
  }
  if (
    query.pointer.startsWith("file-service://") &&
    !ownsFile(query.pointer.slice("file-service://".length), accountKey())
  ) {
    return reply.code(404).send({ error: "File not found" });
  }
  if (
    query.pointer.startsWith("sediment://") &&
    (!query.upstreamConversationId ||
      !ownsUpstreamConversation(query.upstreamConversationId, accountKey()))
  ) {
    return reply.code(404).send({ error: "Conversation asset not found" });
  }
  const client = new ChatGptBackendClient(await getValidCredentials());
  const url = await client.resolveAssetDownload(
    query.pointer,
    query.upstreamConversationId,
  );
  return reply.redirect(url);
});

function publicEvent(
  event: NormalizedConversationEvent,
): Record<string, unknown> | null {
  if (
    event.displayHidden ||
    event.kind === "raw" ||
    event.kind === "assistant_text" ||
    event.kind === "message"
  )
    return null;
  const { raw: _raw, ...safe } = event as NormalizedConversationEvent & {
    raw?: unknown;
  };
  return safe;
}


app.post("/api/chat", async (req, reply) => {
  const body = ChatBody.parse(req.body);
  if (
    body.attachments.some(
      (attachment) => !ownsFile(attachment.fileId, accountKey()),
    )
  ) {
    return reply
      .code(404)
      .send({ error: "One or more attachments do not belong to this account" });
  }
  const controller = new AbortController();
  req.raw.once("aborted", () => controller.abort());
  reply.raw.once("close", () => {
    if (!reply.raw.writableEnded) controller.abort();
  });
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  reply.raw.socket?.setNoDelay(true);
  const send = (event: string, data: unknown) =>
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const turnstileToken =
      body.turnstileToken ??
      (typeof req.headers["openai-sentinel-turnstile-token"] === "string"
        ? req.headers["openai-sentinel-turnstile-token"]
        : undefined) ??
      (typeof req.headers["x-turnstile-token"] === "string"
        ? req.headers["x-turnstile-token"]
        : undefined);
    const { conversation, result, storedAssistantMessageId } = await runChat({
      ...body,
      turnstileToken,
      signal: controller.signal,
      onDelta: (delta) => send("delta", { delta }),
      onEvent: (event) => {
        const safe = publicEvent(event);
        if (safe) send("event", safe);
      },
    });
    send("done", {
      text: result.text,
      conversationId: conversation.id,
      upstreamConversationId: result.conversationId,
      messageId: result.messageId,
      assistantMessageId: storedAssistantMessageId,
      model: conversation.model,
      init: conversation.init,
    });
  } catch (error) {
    send("error", {
      message:
        error instanceof Error && error.name === "AbortError"
          ? "Generation stopped"
          : String((error as Error)?.message ?? error),
    });
  } finally {
    reply.raw.end();
  }
});

await registerOpenAiRoutes(app);
await registerAssetContentRoute(app);
await registerInsightRoutes(app);
registerDecoderChallengeRoutes(app, () => JSON.stringify([accountKey(), getSessionRevision()]));
registerConversionRoutes(app);

// OpenAPI: generated from the same Zod schemas the routes validate against
// (see openapi-document.ts) rather than a hand-maintained JSON file. `mode:
// "static"` tells @fastify/swagger to serve this document as-is instead of
// trying to introspect Fastify route schemas (most routes here validate
// manually with Zod inside the handler body, not via Fastify's own `schema`
// option, so there'd be nothing for the automatic mode to find).
if (!options.worker) {
  await app.register(fastifySwagger, {
    mode: "static",
    // zod-openapi's OpenAPIObject type models the OpenAPI spec slightly more
    // strictly than @fastify/swagger's own openapi-types import.
    specification: { document: buildOpenApiDocument() as any },
  });
  await app.register(fastifySwaggerUi, { routePrefix: "/mirror/api-docs" });
} else {
  app.get("/mirror/api-docs", (_req, reply) => reply.type("text/html; charset=utf-8").send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mirror API docs</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.20.0/swagger-ui.css"></head>
<body><div id="swagger-ui"></div><script src="https://unpkg.com/swagger-ui-dist@5.20.0/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({url:"/mirror/openapi",dom_id:"#swagger-ui"})</script></body></html>`));
}
const OpenApiQuery = z.object({ format: z.enum(["json", "yaml"]).default("json") });
app.get("/mirror/openapi", async (req, reply) => {
  const { format } = OpenApiQuery.parse(req.query);
  const doc = options.worker ? buildOpenApiDocument() : app.swagger();
  if (format === "yaml") return reply.type("application/yaml").send(toYaml(doc));
  return reply.type("application/json").send(doc);
});

const staticRoot = options.worker ? "" : path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../web/dist",
);
if (!options.worker) {
  await app.register(fastifyStatic, {
    root: staticRoot,
    prefix: "/mirror/",
    wildcard: false,
    decorateReply: true,
  });
  app.get("/mirror/playground", (_req, reply) => reply.sendFile("index.html"));
} else {
  app.get("/mirror/playground", async (req, reply) => {
    if (!options.assets) return reply.code(503).send({ error: "Static assets are unavailable" });
    const asset = await options.assets.fetch(new Request(new URL("/index.html", req.protocol + "://" + req.headers.host)));
    if (!asset.ok) return reply.code(asset.status).send(await asset.text());
    reply.type(asset.headers.get("content-type") ?? "text/html; charset=utf-8");
    return reply.send(Buffer.from(await asset.arrayBuffer()));
  });
  app.get("/mirror/assets/*", async (req, reply) => {
    if (!options.assets) return reply.code(503).send({ error: "Static assets are unavailable" });
    const path = req.url.split("?", 1)[0]!.replace(/^\/mirror/, "");
    const asset = await options.assets.fetch(new Request(new URL(path, req.protocol + "://" + req.headers.host)));
    reply.code(asset.status);
    asset.headers.forEach((value, key) => reply.header(key, value));
    return reply.send(Buffer.from(await asset.arrayBuffer()));
  });
  app.get("/assets/*", async (req, reply) => {
    if (!options.assets) return reply.code(503).send({ error: "Static assets are unavailable" });
    const asset = await options.assets.fetch(new Request(new URL(req.url, req.protocol + "://" + req.headers.host)));
    reply.code(asset.status);
    asset.headers.forEach((value, key) => reply.header(key, value));
    return reply.send(Buffer.from(await asset.arrayBuffer()));
  });
  app.get("/favicon.ico", async (req, reply) => {
    if (!options.assets) return reply.code(503).send({ error: "Static assets are unavailable" });
    const asset = await options.assets.fetch(new Request(new URL("/favicon.ico", req.protocol + "://" + req.headers.host)));
    reply.code(asset.status);
    asset.headers.forEach((value, key) => reply.header(key, value));
    return reply.send(Buffer.from(await asset.arrayBuffer()));
  });
}
app.get("/mirror/inject.css", (_req, reply) =>
  reply.type("text/css").send(injectionCss),
);
app.get("/mirror/inject.js", (_req, reply) =>
  reply.type("application/javascript").send(injectionJs),
);
app.setNotFoundHandler(async (req, reply) => {
  // Every Mirror-owned /api route is registered above. Any remaining route may
  // belong to the official ChatGPT frontend and must be proxied upstream.
  if (req.url.startsWith("/v1/"))
    return reply.code(404).send({ error: "Not found" });
  return proxyChatGpt(req, reply);
});

return app;
}

if (typeof (globalThis as typeof globalThis & { WebSocketPair?: unknown }).WebSocketPair === "undefined" && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
let app: Awaited<ReturnType<typeof buildApp>>;
try {
  app = await buildApp();
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "127.0.0.1";
  await app.listen({ port, host });
  app.log.info(`mirror server listening on http://${host}:${port}`);
} catch (error) {
  // Startup failures (bad config, an incompatible database, a port already in use)
  // are classified into one actionable
  // line instead of surfacing as a raw unhandled-rejection stack trace -
  // see preflight.ts for why these four categories specifically.
  console.error(formatStartupFailure(error));
  process.exit(1);
}
}
