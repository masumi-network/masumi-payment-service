import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import {
  getReportsFacets,
  postReportsSummary,
  type GetReportsFacetsResponses,
  type PostReportsSummaryData,
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
} from '@/components/transactions/download-details.helpers';

type ReportFacets = GetReportsFacetsResponses[200]['data'];
type ReportPaymentSource = ReportFacets['paymentSources'][number];
type ReportSummary = PostReportsSummaryResponses[200]['data'];
type ReportBody = PostReportsSummaryData['body'];

type FinancialReportState = Readonly<{
  form: TransactionReportFormState;
  rangeAnchor: Date;
  refreshVersion: number;
}>;

const DASHBOARD_REPORT_DEFAULTS = {
  roles: ['Buyer', 'Seller'],
  states: [],
  hasUnmappedFilters: false,
} as const satisfies TransactionReportViewDefaults;

const LIMIT_GUIDANCE = 'Use a shorter period or select fewer wallets, roles, or states.';
const TIMEOUT_GUIDANCE = 'Use a shorter period or narrower filters, then try again.';

export function resolveFinancialReportSource(
  sources: readonly ReportPaymentSource[],
  network: ReportPaymentSource['network'],
  formPaymentSourceId: string,
  selectedPaymentSourceId: string | null,
): Readonly<{
  paymentSources: ReportPaymentSource[];
  effectivePaymentSourceId: string;
}> {
  const paymentSources = sources
    .filter((source) => source.network === network)
    .sort((left, right) => {
      if (left.deletedAt == null && right.deletedAt != null) return -1;
      if (left.deletedAt != null && right.deletedAt == null) return 1;
      return left.id.localeCompare(right.id);
    });
  const sourceIds = new Set(paymentSources.map((source) => source.id));
  const effectivePaymentSourceId = sourceIds.has(formPaymentSourceId)
    ? formPaymentSourceId
    : selectedPaymentSourceId && sourceIds.has(selectedPaymentSourceId)
      ? selectedPaymentSourceId
      : (paymentSources[0]?.id ?? '');

  return { paymentSources, effectivePaymentSourceId };
}

export function getFinancialReportErrorMessage(
  error: unknown,
  fallback: string,
  status?: number,
): string {
  const message = extractApiErrorMessage(error, fallback);
  const isLimit =
    status === 413 || /(?:exceeds .*?(?:bytes|rows)|row limit|too large)/iu.test(message);
  const isTimeout = status === 504 || /(?:timed out|timeout)/iu.test(message);
  if (isLimit && !message.includes(LIMIT_GUIDANCE)) return `${message} ${LIMIT_GUIDANCE}`;
  if (isTimeout && !message.includes(TIMEOUT_GUIDANCE)) return `${message} ${TIMEOUT_GUIDANCE}`;
  return message;
}

export function isCurrentFinancialReportBody(
  visibleBody: ReportBody | null,
  debouncedBody: ReportBody | null,
): boolean {
  return visibleBody != null && visibleBody === debouncedBody;
}

export function getCurrentFinancialReportExportError(
  error: unknown,
  visibleBody: ReportBody | null,
  attemptedBody: ReportBody | null,
): unknown | null {
  return error != null && isCurrentFinancialReportBody(visibleBody, attemptedBody) ? error : null;
}

function createState(paymentSourceId: string): FinancialReportState {
  return {
    form: createTransactionReportForm(paymentSourceId, DASHBOARD_REPORT_DEFAULTS),
    rangeAnchor: new Date(),
    refreshVersion: 0,
  };
}

export function useFinancialReportModel() {
  const { apiClient, network, selectedPaymentSourceId } = useAppContext();
  const [reportState, setReportState] = useState<FinancialReportState>(() =>
    createState(selectedPaymentSourceId ?? ''),
  );
  const previousSelectedPaymentSourceId = useRef(selectedPaymentSourceId);

  useEffect(() => {
    if (previousSelectedPaymentSourceId.current === selectedPaymentSourceId) return;
    previousSelectedPaymentSourceId.current = selectedPaymentSourceId;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Sidebar source changes reset the report scope and its moving period atomically.
    setReportState(createState(selectedPaymentSourceId ?? ''));
  }, [selectedPaymentSourceId]);

  const facetsQuery = useQuery<ReportFacets>({
    queryKey: TRANSACTION_REPORT_FACETS_QUERY_KEY,
    queryFn: async ({ signal }) => {
      const response = await getReportsFacets({ client: apiClient, signal });
      if (response.error) {
        throw new Error(
          getFinancialReportErrorMessage(
            response.error,
            'Failed to load report filters',
            response.response?.status,
          ),
        );
      }
      const facets = response.data?.data;
      if (!facets) throw new Error('Report filters were missing from the server response.');
      return facets;
    },
    staleTime: 60_000,
    retry: 1,
  });

  const { paymentSources, effectivePaymentSourceId } = useMemo(
    () =>
      resolveFinancialReportSource(
        facetsQuery.data?.paymentSources ?? [],
        network,
        reportState.form.paymentSourceId,
        selectedPaymentSourceId,
      ),
    [facetsQuery.data, network, reportState.form.paymentSourceId, selectedPaymentSourceId],
  );

  const effectiveForm = useMemo<TransactionReportFormState>(
    () => ({
      ...reportState.form,
      paymentSourceId: effectivePaymentSourceId,
      managedWalletIds:
        reportState.form.paymentSourceId === effectivePaymentSourceId
          ? filterAccessibleReportWalletIds(
              reportState.form.managedWalletIds,
              facetsQuery.data?.managedWallets ?? [],
              effectivePaymentSourceId,
            )
          : [],
    }),
    [effectivePaymentSourceId, facetsQuery.data?.managedWallets, reportState.form],
  );

  const selectedPaymentSource = useMemo(
    () => paymentSources.find((source) => source.id === effectivePaymentSourceId) ?? null,
    [effectivePaymentSourceId, paymentSources],
  );

  const managedWallets = useMemo(
    () =>
      (facetsQuery.data?.managedWallets ?? [])
        .filter((wallet) => wallet.paymentSourceId === effectivePaymentSourceId)
        .sort(
          (left, right) => left.type.localeCompare(right.type) || left.id.localeCompare(right.id),
        ),
    [effectivePaymentSourceId, facetsQuery.data],
  );

  const bodyResult = useMemo(
    () => buildTransactionReportBody(effectiveForm, reportState.rangeAnchor),
    [effectiveForm, reportState.rangeAnchor],
  );
  const body = bodyResult.body;
  const debouncedBody = useDebouncedValue(body, 350);
  const isBodyCurrent = isCurrentFinancialReportBody(body, debouncedBody);

  const summaryQuery = useQuery<ReportSummary>({
    queryKey: ['transaction-report-summary', debouncedBody, reportState.refreshVersion],
    queryFn: async ({ signal }) => {
      if (!debouncedBody) throw new Error('Report filters are incomplete.');
      const response = await postReportsSummary({ client: apiClient, body: debouncedBody, signal });
      if (response.error) {
        throw new Error(
          getFinancialReportErrorMessage(
            response.error,
            'Failed to load financial report',
            response.response?.status,
          ),
        );
      }
      const summary = response.data?.data;
      if (!summary) throw new Error('Report summary was missing from the server response.');
      return summary;
    },
    enabled: isBodyCurrent,
    staleTime: 60_000,
    retry: false,
  });

  const exportMutation = useMutation({
    mutationFn: async (reportBody: ReportBody) => {
      const file = await fetchTransactionReportExport({
        client: apiClient,
        body: reportBody,
        kind: 'zip',
      });
      saveTransactionReportExport(file);
    },
    onSuccess: (_result, reportBody) => {
      if (isCurrentFinancialReportBody(body, reportBody)) {
        toast.success('Report ZIP download started');
      }
    },
    onError: (error: unknown, reportBody) => {
      if (isCurrentFinancialReportBody(body, reportBody)) {
        toast.error(getFinancialReportErrorMessage(error, 'Failed to export transaction report'));
      }
    },
  });

  const exportZip = useCallback(() => {
    if (body) exportMutation.mutate(body);
  }, [body, exportMutation]);

  const updateForm = useCallback((patch: Partial<TransactionReportFormState>) => {
    setReportState((current) => ({
      ...current,
      form: { ...current.form, ...patch },
    }));
  }, []);

  const setPaymentSource = useCallback((paymentSourceId: string) => {
    setReportState((current) => ({
      ...current,
      form: { ...current.form, paymentSourceId, managedWalletIds: [] },
      rangeAnchor: new Date(),
    }));
  }, []);

  const toggleRole = useCallback((role: ReportRole) => {
    setReportState((current) => ({
      ...current,
      form: { ...current.form, roles: toggleReportFilterValue(current.form.roles, role) },
    }));
  }, []);

  const toggleState = useCallback((state: ReportOnChainState) => {
    setReportState((current) => ({
      ...current,
      form: { ...current.form, states: toggleReportFilterValue(current.form.states, state) },
    }));
  }, []);

  const toggleWallet = useCallback(
    (walletId: string) => {
      setReportState((current) => ({
        ...current,
        form: toggleReportWalletSelection(current.form, effectivePaymentSourceId, walletId),
      }));
    },
    [effectivePaymentSourceId],
  );

  const reset = useCallback(() => {
    setReportState((current) => ({
      ...createState(effectivePaymentSourceId),
      refreshVersion: current.refreshVersion + 1,
    }));
  }, [effectivePaymentSourceId]);

  const refresh = useCallback(() => {
    setReportState((current) => ({
      ...current,
      rangeAnchor: new Date(),
      refreshVersion: current.refreshVersion + 1,
    }));
  }, []);

  const summaryError =
    isBodyCurrent && summaryQuery.error
      ? extractApiErrorMessage(summaryQuery.error, 'Failed to load financial report')
      : null;
  const isLoadingSummary = body != null && (!isBodyCurrent || summaryQuery.isLoading);
  const isRefetching =
    body != null && !summaryQuery.isLoading && (!isBodyCurrent || summaryQuery.isFetching);
  const currentExportError = getCurrentFinancialReportExportError(
    exportMutation.error,
    body,
    exportMutation.variables ?? null,
  );

  return {
    body,
    bodyError: bodyResult.error,
    effectivePaymentSourceId,
    exportError: currentExportError
      ? getFinancialReportErrorMessage(currentExportError, 'Failed to export transaction report')
      : null,
    exportZip,
    facetsError: facetsQuery.error
      ? extractApiErrorMessage(facetsQuery.error, 'Failed to load report filters')
      : null,
    form: effectiveForm,
    isExporting: exportMutation.isPending,
    isLoadingFacets: facetsQuery.isLoading,
    isLoadingSummary,
    isRefetching,
    managedWallets,
    paymentSources,
    refresh,
    reset,
    selectedPaymentSource,
    setPaymentSource,
    summary: isBodyCurrent ? (summaryQuery.data ?? null) : null,
    summaryError,
    toggleRole,
    toggleState,
    toggleWallet,
    updateForm,
  };
}
