/** OpenAI-shaped error envelopes; upstream bodies are preserved when available. */
const categories: Record<number, [string, string]> = {
  400: ["invalid_request_error", "invalid_request"],
  401: ["authentication_error", "authentication_required"],
  403: ["permission_error", "request_forbidden"],
  404: ["invalid_request_error", "not_found"],
  409: ["invalid_request_error", "conversation_conflict"],
  428: ["challenge_required_error", "challenge_required"],
  429: ["rate_limit_error", "rate_limit_exceeded"],
  504: ["timeout_error", "deadline_exceeded"],
};
const recent: Array<{ at: string; code: string; requestId: string; protocolCategory: string | null }> = [];
export function apiError(status: number, message: string, requestId: string, _useUpstreamMessage = false) {
  const [type, code] = categories[status] ?? ["server_error", "upstream_failure"];
  return { error: { type, code, message, request_id: requestId } };
}

/** Put the complete upstream response body in OpenAI's error.message field. */
export function upstreamErrorMessage(responseText: string): string {
  return responseText;
}
export function recordFailure(code: string, requestId: string, protocolCategory: string | null = null) {
  recent.push({ at: new Date().toISOString(), code, requestId, protocolCategory });
  if (recent.length > 20) recent.shift();
}
export function recentFailures() { return recent.map(item => ({ ...item })); }
