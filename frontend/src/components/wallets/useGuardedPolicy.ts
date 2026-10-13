import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { postWalletGuardedPolicy } from '@/lib/api/generated';
import { extractApiErrorMessage } from '@/lib/api-error';
import { useAppContext } from '@/lib/contexts/AppContext';
import type { useCip30Wallet } from '@/lib/cip30/useCip30Wallet';
import { decodePolicyUpdateTx, policyUpdateProblem } from './guarded-policy-check';
import {
  buildPolicyBody,
  policyExpectation,
  policyRowsFor,
  type GuardedChain,
  type GuardedRecord,
  type PolicyRow,
} from './guarded-policy-form';
import { guardedWalletQueryKey } from './useGuardedWallet';
import { dataOf } from './useGuardedHydra';

/** Ledger errors that mean the wallet UTxO was spent between prepare and submit. */
const STALE_INPUT = /BadInputsUTxO|ValueNotConservedUTxO|already been spent|unknown input/i;

/**
 * The owner's "Limits and deposit" action: the service prepares the
 * `UpdatePolicy`, the browser checks it, the owner wallet signs and submits it.
 * The service keeps no record of it; the next chain read shows the result.
 */
export function useGuardedPolicy({
  hotWalletId,
  network,
  guarded,
  chain,
  agentVkh,
  ownerWallet,
}: {
  hotWalletId: string;
  network: 'Preprod' | 'Mainnet';
  guarded: GuardedRecord;
  chain: GuardedChain | null;
  agentVkh: string;
  ownerWallet: ReturnType<typeof useCip30Wallet>;
}) {
  const { apiClient } = useAppContext();
  const queryClient = useQueryClient();
  /** Null while the dialog is closed. */
  const [rows, setRows] = useState<PolicyRow[] | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const open = () => {
    if (chain != null) setRows(policyRowsFor(chain, guarded.governedAsset, network));
  };

  const submit = async () => {
    if (rows == null || chain == null) return;
    const built = buildPolicyBody(hotWalletId, rows);
    if ('error' in built) {
      toast.error(built.error);
      return;
    }
    const problem = ownerWallet.signingProblem(network, guarded.ownerAddress);
    if (problem != null) {
      toast.error(problem);
      return;
    }
    setIsBusy(true);
    try {
      const prepared = await dataOf(
        postWalletGuardedPolicy({ client: apiClient, body: built.body }),
        'Failed to prepare the update',
      );
      const refusal = policyUpdateProblem(
        decodePolicyUpdateTx(prepared.unsignedTx),
        policyExpectation({ guarded, chain, agentVkh, body: built.body }),
      );
      if (refusal != null) throw new Error(`Not signed. ${refusal}`);
      const signedTx = await ownerWallet.signPartial(prepared.unsignedTx);
      const txHash = await ownerWallet.submit(signedTx);
      toast.success(
        `Update submitted (${txHash.slice(0, 10)}…). The new limits show once it confirms`,
      );
      setRows(null);
      await queryClient.invalidateQueries({ queryKey: guardedWalletQueryKey(hotWalletId) });
    } catch (cause) {
      const message = extractApiErrorMessage(cause, 'The update failed');
      toast.error(
        STALE_INPUT.test(message)
          ? 'The wallet changed while you signed. Submit again to use its new state'
          : message,
      );
    } finally {
      setIsBusy(false);
    }
  };

  return {
    rows,
    setRows,
    open,
    close: () => setRows(null),
    canOpen: chain != null,
    isBusy,
    blockedReason: ownerWallet.signingProblem(network, guarded.ownerAddress),
    submit,
  };
}
