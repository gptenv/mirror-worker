declare module "cloudflare:workers" {
  export class DurableObject<Env = unknown> {
    protected ctx: unknown;
    protected env: Env;
    constructor(ctx: unknown, env: Env);
  }
}

declare module "cloudflare:node" {
  export function httpServerHandler(server: import("node:http").Server): {
    fetch(request: Request): Promise<Response>;
  };
}
