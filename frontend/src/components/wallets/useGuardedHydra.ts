import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import {
  getWalletGuardedHydra,
  postWalletGuardedHydraDeposit,
  postWalletGuardedHydraDepositRecover,
  postWalletGuardedHydraDepositSubmit,
  postWalletGuardedHydraWithdraw,
  postWalletGuardedHydraWithdrawSubmit,
} from '@/lib/api/generated';
import { extractApiErrorMessage } from '@/lib/api-error';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useHydraHeads } from '@/lib/hooks/hydra/heads';
import type { useCip30Wallet } from '@/lib/cip30/useCip30Wallet';
import { hasMoveInFlight, openHeadsForWallet } from './guarded-hydra-utils';
import { decodeMoveTx, moveExpectation, moveProblem } from './guarded-move-check';

const IN_FLIGHT_POLL_MS = 5000;

export type GuardedHydraAction = 'deposit' | 'withdraw' | 'recover';

/** Unwraps a generated SDK response, or throws its API error as a readable message. */
export async function dataOf<T>(
  call: Promise<{ data?: { data: T }; error?: unknown }>,
  fallback: string,
): Promise<T> {
  const response = await call;
  if (response.error != null || response.data == null) {
    throw new Error(extractApiErrorMessage(response.error, fallback));
  }
  return response.data.data;
}

/**
 * Moves a guarded wallet into a Hydra head and back. The service prepares each
 * move, the owner signs it in a CIP-30 browser wallet, and the service submits.
 */
export function useGuardedHydra({
  hotWalletId,
  ownerAddress,
  network,
  enabled,
  ownerWallet,
  guarded,
  agentVkh,
}: {
  hotWalletId: string;
  ownerAddress: string;
  network: 'Preprod' | 'Mainnet';
  enabled: boolean;
  /** What the move must carry: the wallet's script and state token. */
  guarded: { scriptAddress: string; policyId: string; stateTokenName: string };
  agentVkh: string;
  /** Shared with the other owner actions, so one connection serves them all. */
  ownerWallet: ReturnType<typeof useCip30Wallet>;
}) {
  const { apiClient } = useAppContext();
  const queryClient = useQueryClient();
  const { heads } = useHydraHeads(network);
  const [busy, setBusy] = useState<GuardedHydraAction | null>(null);
  const queryKey = ['guarded-hydra', hotWalletId] as const;

  const query = useQuery({
    queryKey,
    queryFn: () =>
      dataOf(
        getWalletGuardedHydra({ client: apiClient, query: { hotWalletId } }),
        'Failed to read where the guarded wallet is',
      ),
    enabled,
    // Reading the status is also what settles an open move on the server.
    refetchInterval: (current) =>
      hasMoveInFlight(current.state.data ?? null) ? IN_FLIGHT_POLL_MS : false,
  });

  const run = async (action: GuardedHydraAction, work: () => Promise<string>) => {
    setBusy(action);
    try {
      toast.success(await work());
    } catch (cause) {
      toast.error(extractApiErrorMessage(cause, `The ${action} failed`));
    } finally {
      setBusy(null);
      await queryClient.invalidateQueries({ queryKey });
    }
  };

  /**
   * Prepare, check in the browser, sign, submit. Checks the wallet first so no
   * transfer is prepared for nothing. The check compares the prepared body with
   * the wallet as a fresh status read shows it.
   */
  const signedMove = async (
    direction: 'deposit' | 'withdraw',
    hydraHeadId: string | null,
    prepare: () => Promise<{ transfer: { id: string }; unsignedTx: string }>,
    submit: (transferId: string, signedTx: string) => Promise<unknown>,
  ) => {
    const problem = ownerWallet.signingProblem(network, ownerAddress);
    if (problem != null) throw new Error(problem);
    const fresh = await query.refetch();
    if (fresh.data == null) throw new Error('Could not read where the guarded wallet is');
    const expected = moveExpectation({
      direction,
      status: fresh.data,
      guarded,
      agentVkh,
      headIdentifier:
        hydraHeadId == null
          ? null
          : (heads.find((head) => head.id === hydraHeadId)?.headIdentifier ?? null),
      ownerUtxoRefs: await ownerWallet.ownUtxoRefs(),
    });
    const prepared = await prepare();
    const refusal = moveProblem(decodeMoveTx(prepared.unsignedTx), expected);
    if (refusal != null) throw new Error(`Not signed. ${refusal}`);
    const signedTx = await ownerWallet.signPartial(prepared.unsignedTx);
    await submit(prepared.transfer.id, signedTx);
  };

  const deposit = (hydraHeadId: string) =>
    run('deposit', async () => {
      await signedMove(
        'deposit',
        hydraHeadId,
        () =>
          dataOf(
            postWalletGuardedHydraDeposit({
              client: apiClient,
              body: { hotWalletId, hydraHeadId },
            }),
            'Failed to prepare the deposit',
          ),
        (transferId, signedTx) =>
          dataOf(
            postWalletGuardedHydraDepositSubmit({
              client: apiClient,
              body: { transferId, signedTx },
            }),
            'Failed to submit the deposit',
          ),
      );
      return 'Deposit submitted. The head takes it in after the activation delay';
    });

  const withdraw = () =>
    run('withdraw', async () => {
      await signedMove(
        'withdraw',
        null,
        () =>
          dataOf(
            postWalletGuardedHydraWithdraw({ client: apiClient, body: { hotWalletId } }),
            'Failed to prepare the withdrawal',
          ),
        (transferId, signedTx) =>
          dataOf(
            postWalletGuardedHydraWithdrawSubmit({
              client: apiClient,
              body: { transferId, signedTx },
            }),
            'Failed to submit the withdrawal',
          ),
      );
      return 'Withdrawal submitted. The wallet returns to L1 when the head confirms it';
    });

  const recover = (transferId: string) =>
    run('recover', async () => {
      const result = await dataOf(
        postWalletGuardedHydraDepositRecover({ client: apiClient, body: { transferId } }),
        'Failed to recover the deposit',
      );
      return result.reason ?? 'Recovery confirmed. The wallet is back on L1';
    });

  return {
    state: query.data ?? null,
    isLoading: query.isLoading,
    loadError: query.error ? query.error.message : null,
    openHeads: openHeadsForWallet(heads, hotWalletId),
    busy,
    deposit,
    withdraw,
    recover,
  };
}
