/** Optional GPT and project catalogs may be unavailable independently of base models. */
export function optionalCatalog(request: Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  return request.catch((error: unknown) => {
    const status = (error as { statusCode?: number; status?: number } | null)?.statusCode
      ?? (error as { status?: number } | null)?.status;
    if (status === 401 || status === 403) throw error;
    return {};
  });
}
