import { useMemo } from 'react';
import {
  postAgentValidationHash,
  postAgentValidationProbe,
  postAgentValidationValidate,
  type PostAgentValidationHashData,
  type PostAgentValidationHashResponse,
  type PostAgentValidationProbeData,
  type PostAgentValidationProbeResponse,
  type PostAgentValidationValidateData,
} from '@/lib/api/generated';
import { useAppContext } from '@/lib/contexts/AppContext';
import { settle } from '@/lib/agent-validation/api-outcome';

export type ProbeBody = NonNullable<PostAgentValidationProbeData['body']>;
export type ProbeResult = PostAgentValidationProbeResponse['data'];
export type ValidateBody = NonNullable<PostAgentValidationValidateData['body']>;
export type HashBody = NonNullable<PostAgentValidationHashData['body']>;
export type HashResult = PostAgentValidationHashResponse['data'];

/**
 * The three agent-validation endpoints as plain async functions. They never throw: every failure comes
 * back as `{ ok: false, message }`, so callers decide how to show it.
 */
export function useAgentValidationApi() {
  const { apiClient } = useAppContext();
  return useMemo(
    () => ({
      probe: (body: ProbeBody) =>
        settle(
          () => postAgentValidationProbe({ client: apiClient, body }),
          'Could not probe the agent',
        ),
      validate: (body: ValidateBody) =>
        settle(
          () => postAgentValidationValidate({ client: apiClient, body }),
          'Could not validate the JSON',
        ),
      hash: (body: HashBody) =>
        settle(
          () => postAgentValidationHash({ client: apiClient, body }),
          'Could not compute the hash',
        ),
    }),
    [apiClient],
  );
}
