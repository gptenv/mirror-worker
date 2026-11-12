/** OpenAI-shaped error envelopes with status-specific client error classes. */
const categories: Record<number, [string, string]> = {
  400: ["invalid_request_error", "invalid_request"],
  401: ["authentication_error", "authentication_required"],
  403: ["permission_error", "request_forbidden"],
  404: ["not_found_error", "not_found"],
  408: ["timeout_error", "request_timeout"],
  409: ["invalid_request_error", "conversation_conflict"],
  413: ["invalid_request_error", "request_too_large"],
  422: ["invalid_request_error", "invalid_request"],
  428: ["challenge_required_error", "challenge_required"],
  429: ["rate_limit_error", "rate_limit_exceeded"],
  500: ["server_error", "internal_error"],
  502: ["server_error", "upstream_failure"],
  503: ["service_unavailable_error", "service_unavailable"],
  504: ["timeout_error", "deadline_exceeded"],
};
const recent: Array<{ at: string; code: string; requestId: string; protocolCategory: string | null }> = [];
export function apiError(status: number, message: string, requestId: string, _useUpstreamMessage = false) {
  const [type, code] = categories[status] ?? ["server_error", "upstream_failure"];
  return { error: { type, code, message, request_id: requestId } };
}

/** Keep untrusted upstream bodies out of public errors; they can contain secrets. */
export function upstreamErrorMessage(_responseText: string): string {
  return "The upstream request failed.";
}
export function recordFailure(code: string, requestId: string, protocolCategory: string | null = null) {
  recent.push({ at: new Date().toISOString(), code, requestId, protocolCategory });
  if (recent.length > 20) recent.shift();
}
export function recentFailures() { return recent.map(item => ({ ...item })); }
