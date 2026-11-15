const workerRequestSignals = new Map<string, AbortSignal>();

/** Register a Worker's incoming signal while its bridged Fastify request runs. */
export function registerWorkerRequestSignal(id: string | null, signal: AbortSignal): () => void {
  if (!id) return () => {};
  workerRequestSignals.set(id, signal);
  return () => {
    if (workerRequestSignals.get(id) === signal) workerRequestSignals.delete(id);
  };
}

export function getWorkerRequestSignal(id: unknown): AbortSignal | undefined {
  return typeof id === "string" ? workerRequestSignals.get(id) : undefined;
}
