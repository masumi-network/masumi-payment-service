import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { useAppContext } from '@/lib/contexts/AppContext';
import { readHydraNodeFunding, updateHydraNodeFunding } from './hydra/funds';
import {
  fundingLovelaceToAda,
  parseAutomaticFundingLimit,
} from '@/components/hydra/automatic-funding';

type FundingDraft = { autoFund: boolean; hasLimit: boolean; limitAda: string };

export function useHydraAutomaticFunding(participantId: string) {
  const { apiClient } = useAppContext();
  const [draft, setDraft] = useState<FundingDraft | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const query = useQuery({
    queryKey: ['hydra-node-funding', participantId],
    queryFn: () => readHydraNodeFunding(apiClient, { id: participantId }),
    staleTime: 0,
  });
  const funding = query.data;
  const settings = draft ?? {
    autoFund: funding?.autoFund ?? false,
    hasLimit: funding?.automaticFundingLimitLovelace != null,
    limitAda:
      funding?.automaticFundingLimitLovelace != null
        ? fundingLovelaceToAda(funding.automaticFundingLimitLovelace)
        : '',
  };
  const limitLovelace = settings.hasLimit ? parseAutomaticFundingLimit(settings.limitAda) : null;
  const limitError =
    settings.hasLimit && limitLovelace === null
      ? 'Enter zero or a positive ADA amount with at most six decimal places, within the supported limit.'
      : null;

  function change(patch: Partial<FundingDraft>) {
    setDraft({ ...settings, ...patch });
  }

  async function save(): Promise<boolean> {
    if (!funding || limitError || isSaving || query.isFetching || query.error) return false;
    setIsSaving(true);
    try {
      await updateHydraNodeFunding(apiClient, {
        id: participantId,
        autoFund: settings.autoFund,
        automaticFundingLimitLovelace: limitLovelace,
      });
      toast.success('Automatic funding settings saved');
      return true;
    } catch {
      return false;
    } finally {
      setIsSaving(false);
    }
  }

  return {
    funding,
    settings,
    change,
    save,
    isSaving,
    limitError,
    isLoading: query.isPending || query.isFetching,
    error: query.error,
    retry: query.refetch,
  };
}
