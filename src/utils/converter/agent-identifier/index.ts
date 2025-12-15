export function extractAssetName(agentIdentifier: string): string {
  if (agentIdentifier.length < 56) {
    throw new Error('Agent identifier is too short');
  }
  return agentIdentifier.slice(56);
}

export function extractPolicyId(agentIdentifier: string): string {
  if (agentIdentifier.length < 56) {
    throw new Error('Agent identifier is too short');
  }
  return agentIdentifier.slice(0, 56);
}
