import { AsyncLocalStorage } from "node:async_hooks";

export type UpstreamFetch = typeof globalThis.fetch;
const requestTransport = new AsyncLocalStorage<UpstreamFetch>();

/** Keep each request's network binding isolated from concurrent requests. */
export function runWithUpstreamFetch<T>(transport: UpstreamFetch, callback: () => T): T {
  return requestTransport.run(transport, callback);
}

/** Node uses its normal transport; Workers explicitly supply their VPC binding. */
export const upstreamFetch: UpstreamFetch = (input, init) =>
  (requestTransport.getStore() ?? globalThis.fetch)(input, init);
