/** Configuration is not a connectivity check. No upstream probe runs here. */
export interface EgressStatus {
  mode: "direct" | "warp-vpc";
  required: boolean;
  verified: false;
  checkedAt: null;
  error: null;
}

export function getEgressStatus(): EgressStatus {
  const worker = typeof (globalThis as typeof globalThis & { WebSocketPair?: unknown }).WebSocketPair !== "undefined";
  return {
    mode: worker ? "warp-vpc" : "direct",
    required: worker,
    verified: false,
    checkedAt: null,
    error: null,
  };
}
