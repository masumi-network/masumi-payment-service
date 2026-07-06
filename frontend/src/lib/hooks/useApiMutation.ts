import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { extractApiErrorMessage } from '@/lib/api-error';

type ApiResult = object | null | undefined;

/**
 * Standard wrapper for write operations against the generated API client.
 *
 * The generated client resolves with `{ error }` instead of throwing, so this
 * mirrors handleApiCall's contract: an `error` field on the response is
 * converted into a thrown Error, surfaced as a toast, and reported through
 * TanStack's mutation state. On success the given query keys are invalidated
 * so reads refetch automatically.
 *
 * Prefer this over calling `handleApiCall` imperatively inside components —
 * it centralizes loading state (`isPending`), error toasts, and cache
 * invalidation in one place.
 *
 * Usage:
 *   const createKey = useApiMutation({
 *     mutationFn: (body: PostApiKeyData['body']) => postApiKey({ client: apiClient, body }),
 *     invalidateKeys: [['apiKeys']],
 *     errorMessage: 'Failed to create API key',
 *   });
 *   ...
 *   const response = await createKey.mutateAsync(body); // throws on API error
 */
export function useApiMutation<TVariables, TData extends ApiResult>(options: {
  mutationFn: (variables: TVariables) => Promise<TData>;
  /** Query keys to invalidate after a successful mutation. */
  invalidateKeys?: QueryKey[];
  /** Fallback toast message when the API error carries no message. */
  errorMessage?: string;
  /** Optional success toast. Omit when the caller shows its own UI. */
  successMessage?: string;
  /** Set false to let the caller render errors itself (no toast). */
  toastOnError?: boolean;
}) {
  const queryClient = useQueryClient();
  const { mutationFn, invalidateKeys, errorMessage, successMessage, toastOnError = true } = options;

  return useMutation({
    mutationFn: async (variables: TVariables) => {
      const response = await mutationFn(variables);
      if (response && typeof response === 'object' && 'error' in response && response.error) {
        throw new Error(extractApiErrorMessage(response.error, errorMessage ?? 'API call failed'));
      }
      return response;
    },
    onSuccess: async () => {
      if (invalidateKeys?.length) {
        await Promise.all(
          invalidateKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
        );
      }
      if (successMessage) {
        toast.success(successMessage);
      }
    },
    onError: (error: Error) => {
      if (toastOnError) {
        toast.error(error.message);
      }
    },
  });
}
