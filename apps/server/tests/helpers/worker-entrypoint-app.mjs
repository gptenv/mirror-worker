export async function buildApp(options) {
  globalThis.__testStarts = (globalThis.__testStarts || 0) + 1;
  return { ready: async () => {}, server: { fetch: async request => Response.json({ owner: options.ownerUserId, authorization: request.headers.get('authorization') }) } };
}
