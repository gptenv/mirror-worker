import { DurableObject } from "cloudflare:workers";
import { httpServerHandler } from "cloudflare:node";
import { buildApp, type WorkerAssets } from "./index.js";
import { initializeWorkerStore } from "./store.js";
import type { DurableSqlStorage } from "./worker-sql.js";
import { runWithRequestSessionToken } from "./auth.js";
import { runWithUpstreamFetch, type UpstreamFetch } from "@mirror/protocol";
import { configuredApiKeys } from "./security.js";
import { registerWorkerRequestSignal } from "./worker-request-signals.js";

interface DurableObjectState {
  storage: DurableSqlStorage;
}

interface WorkerEnvironment {
  MIRROR: DurableObjectNamespace;
  ASSETS: WorkerAssets;
  WARP?: { fetch: UpstreamFetch };
  MIRROR_STORE_KEY?: string;
  MIRROR_OWNER_ACCOUNT_ID?: string;
  MIRROR_API_KEY?: string;
  MIRROR_API_KEYS?: string;
  OPENAI_API_KEY?: string;
}

interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

type HttpServerHandler = (request: Request) => Promise<Response>;

/** Holds the single-account Mirror state and preserves the existing Fastify routes. */
export class MirrorStorage extends DurableObject<WorkerEnvironment> {
  private handlerPromise?: Promise<HttpServerHandler>;
  constructor(ctx: DurableObjectState, env: WorkerEnvironment) {
    super(ctx, env);
    initializeWorkerStore(ctx.storage, env.MIRROR_STORE_KEY);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return new Response("WebSocket proxying is disabled in this Worker deployment.", { status: 501 });
    }
    this.handlerPromise ??= this.startServer().catch((error: unknown) => {
      this.handlerPromise = undefined;
      throw error;
    });
    const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    const sessionToken = request.headers.get("x-mirror-session-token") ?? undefined;
    const unregisterSignal = registerWorkerRequestSignal(request.headers.get("x-mirror-worker-request-id"), request.signal);
    const upstream = this.env.WARP?.fetch ? this.env.WARP.fetch.bind(this.env.WARP) : fetch;
    try {
      return await runWithUpstreamFetch(upstream, () =>
        runWithRequestSessionToken(token, () => this.handlerPromise!.then((handler) => handler(request)), sessionToken,
          configuredApiKeys({ MIRROR_API_KEY: this.env.MIRROR_API_KEY, MIRROR_API_KEYS: this.env.MIRROR_API_KEYS, OPENAI_API_KEY: this.env.OPENAI_API_KEY })));
    } finally {
      unregisterSignal();
    }
  }

  private async startServer(): Promise<HttpServerHandler> {
    const ownerUserId = this.env.MIRROR_OWNER_ACCOUNT_ID?.trim() || undefined;
    const app = await buildApp({ worker: true, assets: this.env.ASSETS, ownerUserId });
    await app.ready();
    const handler = httpServerHandler(app.server);
    return (request) => handler.fetch(request);
  }
}

export default {
  async fetch(request: Request, env: WorkerEnvironment): Promise<Response> {
    const headers = new Headers(request.headers);
    const url = new URL(request.url);
    // Forwarded headers are rewritten here, at the trusted Cloudflare edge,
    // before the internal request reaches Fastify's Node HTTP bridge.
    for (const name of ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip"])
      headers.delete(name);
    headers.set("x-forwarded-host", url.host);
    headers.set("x-forwarded-proto", url.protocol.slice(0, -1));
    const clientIp = request.headers.get("cf-connecting-ip");
    if (clientIp) headers.set("x-forwarded-for", clientIp);

    // Preserve the Worker's abort signal across this internal request. The
    // Node HTTP bridge does not expose that signal on Fastify's request, so an
    // internal ID lets Worker routes resolve it from a short lived registry.
    headers.set("x-mirror-worker-request-id", crypto.randomUUID());
    const internalRequest = new Request(request, { headers, signal: request.signal });
    const id = env.MIRROR.idFromName("mirror-single-account");
    return env.MIRROR.get(id).fetch(internalRequest);
  },
};
