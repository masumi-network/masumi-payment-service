import { extractApiErrorMessage } from '../api-error';

/** What a call to the generated client resolves to: `{ data, error }`, never a throw for an HTTP error. */
type ClientResponse<T> = { data?: { data: T }; error?: unknown };

export type ApiOutcome<T> = { ok: true; data: T } | { ok: false; message: string };

export function outcomeOf<T>(response: ClientResponse<T>, fallback: string): ApiOutcome<T> {
  if (response.error != null) {
    return { ok: false, message: extractApiErrorMessage(response.error, fallback) };
  }
  if (response.data == null) return { ok: false, message: fallback };
  return { ok: true, data: response.data.data };
}

/** Runs a client call and folds every failure, including a thrown network error, into the outcome. */
export async function settle<T>(
  call: () => Promise<ClientResponse<T>>,
  fallback: string,
): Promise<ApiOutcome<T>> {
  try {
    return outcomeOf(await call(), fallback);
  } catch (error) {
    return { ok: false, message: extractApiErrorMessage(error, fallback) };
  }
}
