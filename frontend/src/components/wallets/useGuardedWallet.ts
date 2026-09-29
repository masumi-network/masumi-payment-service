import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import {
  deleteWalletGuarded,
  getWalletGuarded,
  postWalletGuarded,
  type PostWalletGuardedData,
} from '@/lib/api/generated';
import { extractApiErrorMessage } from '@/lib/api-error';
import { useAppContext } from '@/lib/contexts/AppContext';
import { handleApiCall } from '@/lib/utils';
import { adaToLovelace } from '@/components/hydra/ada-amount';

export type GuardedAttachBody = NonNullable<PostWalletGuardedData['body']>;

/** The attach form as the operator types it. Mandate amounts are in ADA. */
export type GuardedAttachForm = {
  ownerAddress: string;
  quorumKeys: string;
  threshold: string;
  stateTokenName: string;
  mode: 'existing' | 'register';
  exchainWalletId: string;
  perTxCapAda: string;
  dailyAda: string;
  perSellerAda: string;
  perAgentAda: string;
  envelopeAda: string;
  burstPerMinute: string;
};

export const EMPTY_GUARDED_ATTACH_FORM: GuardedAttachForm = {
  ownerAddress: '',
  quorumKeys: '',
  threshold: '',
  stateTokenName: '',
  mode: 'existing',
  exchainWalletId: '',
  perTxCapAda: '',
  dailyAda: '',
  perSellerAda: '',
  perAgentAda: '',
  envelopeAda: '',
  burstPerMinute: '',
};

/** Quorum key hashes, one per line or separated by commas or spaces. */
export function parseQuorumKeys(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((key) => key.trim().toLowerCase())
    .filter((key) => key !== '');
}

function parsePositiveInt(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return parsed >= 1 && Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Turn the form into the attach request, or say what is wrong with it. The
 * server checks the same rules; this only saves a round trip for typos.
 */
export function buildGuardedAttachBody(
  hotWalletId: string,
  form: GuardedAttachForm,
): { body: GuardedAttachBody } | { error: string } {
  const quorumVkhs = parseQuorumKeys(form.quorumKeys);
  if (quorumVkhs.length === 0) return { error: 'Enter at least one quorum key hash' };
  const threshold = parsePositiveInt(form.threshold);
  if (threshold == null || threshold > quorumVkhs.length) {
    return { error: `Threshold must be between 1 and ${quorumVkhs.length}` };
  }
  const base = {
    hotWalletId,
    ownerAddress: form.ownerAddress.trim(),
    quorumVkhs,
    threshold,
    stateTokenName: form.stateTokenName.trim().toLowerCase(),
  };
  if (base.ownerAddress === '') return { error: 'Enter the owner address' };
  if (base.stateTokenName === '') return { error: 'Enter the state token name' };

  if (form.mode === 'existing') {
    const exchainWalletId = form.exchainWalletId.trim();
    if (exchainWalletId === '') return { error: 'Enter the Exchain wallet id' };
    return { body: { ...base, exchainWalletId } };
  }

  const amounts = {
    perTxCap: adaToLovelace(form.perTxCapAda),
    daily: adaToLovelace(form.dailyAda),
    perSeller: adaToLovelace(form.perSellerAda),
    perAgent: adaToLovelace(form.perAgentAda),
    envelope: adaToLovelace(form.envelopeAda),
  };
  const burstPerMinute = parsePositiveInt(form.burstPerMinute);
  const { perTxCap, daily, perSeller, perAgent, envelope } = amounts;
  if (
    perTxCap == null ||
    daily == null ||
    perSeller == null ||
    perAgent == null ||
    envelope == null
  ) {
    return { error: 'Every mandate limit must be a positive ADA amount' };
  }
  if (burstPerMinute == null) return { error: 'Burst per minute must be a positive whole number' };
  return {
    body: {
      ...base,
      register: { mandate: { perTxCap, daily, perSeller, perAgent, envelope, burstPerMinute } },
    },
  };
}

export function guardedWalletQueryKey(hotWalletId: string | undefined) {
  return ['guarded-wallet', hotWalletId] as const;
}

export function useGuardedWallet({
  hotWalletId,
  enabled,
}: {
  hotWalletId: string | undefined;
  enabled: boolean;
}) {
  const queryClient = useQueryClient();
  const { apiClient } = useAppContext();
  const [form, setForm] = useState<GuardedAttachForm>(EMPTY_GUARDED_ATTACH_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isConfirmingDetach, setIsConfirmingDetach] = useState(false);

  const query = useQuery({
    queryKey: guardedWalletQueryKey(hotWalletId),
    queryFn: async () => {
      const response = await getWalletGuarded({
        client: apiClient,
        query: { hotWalletId: hotWalletId! },
      });
      if (response.error) {
        throw new Error(extractApiErrorMessage(response.error, 'Failed to load guarded wallet'));
      }
      return response.data?.data ?? null;
    },
    enabled: enabled && hotWalletId != null,
  });

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: guardedWalletQueryKey(hotWalletId) }),
      queryClient.invalidateQueries({ queryKey: ['wallets'] }),
    ]);
  };

  const attach = async () => {
    if (hotWalletId == null) return;
    const built = buildGuardedAttachBody(hotWalletId, form);
    if ('error' in built) {
      toast.error(built.error);
      return;
    }
    setIsSubmitting(true);
    await handleApiCall(() => postWalletGuarded({ client: apiClient, body: built.body }), {
      onSuccess: (response) => {
        const mandateEnglish = response.data?.data?.mandateEnglish;
        toast.success(
          mandateEnglish ? `Wallet guarded. Exchain mandate: ${mandateEnglish}` : 'Wallet guarded',
        );
        setForm(EMPTY_GUARDED_ATTACH_FORM);
        void refresh();
      },
      onError: (error: unknown) => {
        toast.error(extractApiErrorMessage(error, 'Failed to guard the wallet'));
      },
      onFinally: () => setIsSubmitting(false),
    });
  };

  const detach = async () => {
    if (hotWalletId == null) return;
    setIsSubmitting(true);
    await handleApiCall(() => deleteWalletGuarded({ client: apiClient, body: { hotWalletId } }), {
      onSuccess: () => {
        toast.success('Guard removed. Purchases now lock from the hot wallet directly');
        setIsConfirmingDetach(false);
        void refresh();
      },
      onError: (error: unknown) => {
        toast.error(extractApiErrorMessage(error, 'Failed to remove the guard'));
      },
      onFinally: () => setIsSubmitting(false),
    });
  };

  return {
    state: query.data ?? null,
    isLoading: query.isLoading,
    loadError: query.error ? query.error.message : null,
    form,
    setForm,
    isSubmitting,
    attach,
    isConfirmingDetach,
    setIsConfirmingDetach,
    detach,
  };
}
