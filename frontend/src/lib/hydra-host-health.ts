/**
 * The problems a Hydra node's last check found. The service writes one problem
 * per line, so a node that fails several checks shows all of them at once.
 */
export function hydraHostHealthProblems(lastHealthError: string | null): string[] {
  if (lastHealthError === null) return [];
  return lastHealthError
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** One line for a toast: the problem itself, or how many there are. */
export function summarizeHydraHostHealth(problems: string[], fallback: string): string {
  if (problems.length === 0) return fallback;
  if (problems.length === 1) return problems[0];
  return `${problems.length} checks failed. Open the node details to see each one.`;
}
