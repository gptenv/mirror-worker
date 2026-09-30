/** Worker deployments use the platform's standard outbound fetch path. */
export interface EgressStatus {
  mode: "direct";
  required: false;
  verified: true;
  checkedAt: string;
  error: null;
}

export function getEgressStatus(): EgressStatus {
  return {
    mode: "direct",
    required: false,
    verified: true,
    checkedAt: new Date().toISOString(),
    error: null,
  };
}
