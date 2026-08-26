import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import {
  getReportsFacets,
  postReportsSummary,
  type GetReportsFacetsResponses,
  type PostReportsSummaryResponses,
} from '@/lib/api/generated';
import { extractApiErrorMessage } from '@/lib/api-error';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useDebouncedValue } from '@/lib/hooks/useDebouncedValue';
import { TRANSACTION_REPORT_FACETS_QUERY_KEY } from '@/lib/queries/transaction-report-cache';
import {
  fetchTransactionReportExport,
  saveTransactionReportExport,
} from '@/lib/transaction-report/download';
import { getFiatIssue } from '@/lib/transaction-report/fiat-settings';
import {
  REPORT_CSV_KINDS,
  isEveryReportCsvKind,
  type ReportCsvKind,
} from './report-export/export-kinds';
import {
  REPORT_PURPOSES,
  applyReportPurpose,
  inferReportPurpose,
  type ReportPurpose,
} from './report-export/report-purposes';
import {
  buildTransactionReportBody,
  createTransactionReportForm,
  filterAccessibleReportWalletIds,
  toggleReportFilterValue,
  toggleReportWalletSelection,
  type ReportOnChainState,
  type ReportRole,
  type TransactionReportFormState,
  type TransactionReportViewDefaults,
} from './download-details.helpers';

type ReportFacets = GetReportsFacetsResponses[200]['data'];
type ReportSummary = PostReportsSummaryResponses[200]['data'];

type UseDownloadDetailsModelOptions = Readonly<{
  open: boolean;
  onClose: () => void;
  viewDefaults: TransactionReportViewDefaults;
  /**
   * Filters the caller already has on screen. The dashboard passes its own
   * report filters so exporting what you are looking at needs no re-picking.
   * Reset still returns to the view defaults.
   */
  initialForm?: TransactionReportFormState;
}>;

function errorMessage(error: unknown, fallback: string): string {
  return extractApiErrorMessage(error, fallback);
}

export function useDownloadDetailsModel({
  open,
  onClose,
  viewDefaults,
  initialForm,
}: UseDownloadDetailsModelOptions) {
  const { apiClient, network, selectedPaymentSourceId } = useAppContext();
  const [rangeAnchor, setRangeAnchor] = useState(() => new Date());
  const [form, setForm] = useState<TransactionReportFormState>(
    () => initialForm ?? createTransactionReportForm(selectedPaymentSourceId ?? '', viewDefaults),
  );
  const [purpose, setPurposeState] = useState<ReportPurpose>(() =>
    inferReportPurpose(initialForm ?? createTransactionReportForm('', viewDefaults)),
  );
  const [exportKinds, setExportKinds] = useState<readonly ReportCsvKind[]>(
    () =>
      REPORT_PURPOSES[
        inferReportPurpose(initialForm ?? createTransactionReportForm('', viewDefaults))
      ].files,
  );

  /**
   * Switching flow clears every filter the new flow hides, so an unseen filter
   * can never narrow the exported file.
   */
  const setPurpose = useCallback((next: ReportPurpose) => {
    setPurposeState(next);
    setForm((current) => applyReportPurpose(current, next));
    if (next !== 'custom') setExportKinds(REPORT_PURPOSES[next].files);
  }, []);

  const reset = useCallback(
    (paymentSourceId = selectedPaymentSourceId ?? '') => {
      setRangeAnchor(new Date());
      const nextForm = createTransactionReportForm(paymentSourceId, viewDefaults);
      const nextPurpose = inferReportPurpose(nextForm);
      setForm(applyReportPurpose(nextForm, nextPurpose));
      setPurposeState(nextPurpose);
      setExportKinds(REPORT_PURPOSES[nextPurpose].files);
    },
    [selectedPaymentSourceId, viewDefaults],
  );

  const facetsQuery = useQuery<ReportFacets>({
    queryKey: TRANSACTION_REPORT_FACETS_QUERY_KEY,
    queryFn: async ({ signal }) => {
      const response = await getReportsFacets({ client: apiClient, signal });
      if (response.error) {
        throw new Error(errorMessage(response.error, 'Failed to load report filters'));
      }
      const facets = response.data?.data;
      if (!facets) throw new Error('Report filters were missing from the server response.');
      return facets;
    },
    enabled: open,
    staleTime: 60_000,
  });

  const paymentSources = useMemo(
    () =>
      (facetsQuery.data?.paymentSources ?? [])
        .filter((source) => source.network === network)
        .sort((left, right) => {
          if (left.deletedAt == null && right.deletedAt != null) return -1;
          if (left.deletedAt != null && right.deletedAt == null) return 1;
          return left.id.localeCompare(right.id);
        }),
    [facetsQuery.data, network],
  );

  const effectivePaymentSourceId = paymentSources.some(
    (source) => source.id === form.paymentSourceId,
  )
    ? form.paymentSourceId
    : (paymentSources.find((source) => source.id === selectedPaymentSourceId)?.id ??
      paymentSources[0]?.id ??
      '');
  const effectiveForm = useMemo(
    () => ({
      ...form,
      paymentSourceId: effectivePaymentSourceId,
      managedWalletIds:
        form.paymentSourceId === effectivePaymentSourceId
          ? filterAccessibleReportWalletIds(
              form.managedWalletIds,
              facetsQuery.data?.managedWallets ?? [],
              effectivePaymentSourceId,
            )
          : [],
    }),
    [effectivePaymentSourceId, facetsQuery.data?.managedWallets, form],
  );

  const preferredPaymentSourceId =
    paymentSources.find((source) => source.id === selectedPaymentSourceId)?.id ??
    paymentSources[0]?.id ??
    '';

  const managedWallets = useMemo(
    () =>
      (facetsQuery.data?.managedWallets ?? [])
        .filter((wallet) => wallet.paymentSourceId === effectiveForm.paymentSourceId)
        .sort(
          (left, right) => left.type.localeCompare(right.type) || left.id.localeCompare(right.id),
        ),
    [effectiveForm.paymentSourceId, facetsQuery.data],
  );

  const bodyResult = useMemo(
    () => buildTransactionReportBody(effectiveForm, rangeAnchor),
    [effectiveForm, rangeAnchor],
  );
  const debouncedBody = useDebouncedValue(bodyResult.body, 350);

  const fiatCapability = facetsQuery.data?.fiat ?? null;
  const fiatIssue = useMemo(
    () => getFiatIssue(fiatCapability, effectiveForm.fiatCurrency, bodyResult.body?.from ?? null),
    [bodyResult.body, effectiveForm.fiatCurrency, fiatCapability],
  );

  const summaryQuery = useQuery<ReportSummary>({
    queryKey: ['transaction-report-preview', debouncedBody],
    queryFn: async ({ signal }) => {
      if (!debouncedBody) throw new Error('Report filters are incomplete.');
      const response = await postReportsSummary({ client: apiClient, body: debouncedBody, signal });
      if (response.error) {
        throw new Error(errorMessage(response.error, 'Failed to preview the report'));
      }
      const summary = response.data?.data;
      if (!summary) throw new Error('Report summary was missing from the server response.');
      return summary;
    },
    enabled: open && bodyResult.body != null && debouncedBody != null && fiatIssue == null,
    staleTime: 0,
  });

  const exportMutation = useMutation({
    mutationFn: async () => {
      if (fiatIssue) throw new Error(fiatIssue.message);
      if (!bodyResult.body) throw new Error(bodyResult.error);
      if (exportKinds.length === 0) throw new Error('Select at least one file to download.');
      // All three files come from the server's own ZIP, so they share one
      // snapshot. A smaller pick is fetched file by file instead.
      const kinds = isEveryReportCsvKind(exportKinds)
        ? (['zip'] as const)
        : REPORT_CSV_KINDS.filter((kind) => exportKinds.includes(kind));
      for (const kind of kinds) {
        const file = await fetchTransactionReportExport({
          client: apiClient,
          body: bodyResult.body,
          kind,
        });
        saveTransactionReportExport(file);
      }
    },
    onSuccess: () => {
      toast.success('Report download started');
      onClose();
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const updateForm = useCallback((patch: Partial<TransactionReportFormState>) => {
    setForm((current) => ({ ...current, ...patch }));
  }, []);

  const toggleRole = useCallback((role: ReportRole) => {
    setForm((current) => ({ ...current, roles: toggleReportFilterValue(current.roles, role) }));
  }, []);

  const toggleState = useCallback((state: ReportOnChainState) => {
    setForm((current) => ({ ...current, states: toggleReportFilterValue(current.states, state) }));
  }, []);

  const toggleWallet = useCallback(
    (walletId: string) => {
      setForm((current) =>
        toggleReportWalletSelection(current, effectivePaymentSourceId, walletId),
      );
    },
    [effectivePaymentSourceId],
  );

  return {
    bodyError: bodyResult.error,
    download: exportMutation.mutate,
    exportKinds,
    facetsError: facetsQuery.error
      ? errorMessage(facetsQuery.error, 'Failed to load report filters')
      : null,
    fiatCapability,
    fiatIssue,
    form: effectiveForm,
    isDownloading: exportMutation.isPending,
    isLoadingFacets: facetsQuery.isLoading,
    isPreviewLoading:
      bodyResult.body != null && (debouncedBody !== bodyResult.body || summaryQuery.isFetching),
    managedWallets,
    paymentSources,
    preview: summaryQuery.data ?? null,
    purpose,
    setPurpose,
    previewError: summaryQuery.error
      ? errorMessage(summaryQuery.error, 'Failed to preview the report')
      : null,
    reset: () => reset(effectiveForm.paymentSourceId || preferredPaymentSourceId),
    setAllExportKinds: (isSelected: boolean) => setExportKinds(isSelected ? REPORT_CSV_KINDS : []),
    toggleExportKind: (kind: ReportCsvKind) =>
      setExportKinds((current) =>
        current.includes(kind)
          ? current.filter((value) => value !== kind)
          : REPORT_CSV_KINDS.filter((value) => value === kind || current.includes(value)),
      ),
    toggleRole,
    toggleState,
    toggleWallet,
    updateForm,
  };
}
