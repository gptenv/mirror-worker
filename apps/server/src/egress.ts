/** Reports the runtime transport class without claiming an upstream probe. */
export interface EgressStatus {
  mode: "direct" | "worker";
  required: false;
  verified: false;
  checkedAt: null;
  error: null;
}

export function getEgressStatus(): EgressStatus {
  const worker = typeof (globalThis as typeof globalThis & { WebSocketPair?: unknown }).WebSocketPair !== "undefined";
  return {
    mode: worker ? "worker" : "direct",
    required: false,
    verified: false,
    checkedAt: null,
    error: null,
  };
}
