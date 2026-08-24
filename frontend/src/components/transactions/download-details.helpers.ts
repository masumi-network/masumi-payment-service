import type { PostReportsSummaryData } from '@/lib/api/generated';
import type { TransactionFilterState } from './TransactionFilters';

type ReportBody = PostReportsSummaryData['body'];

export type ReportRole = NonNullable<ReportBody['roles']>[number];
export type ReportOnChainState = NonNullable<ReportBody['states']>[number];
export type ReportDateBasis = NonNullable<ReportBody['dateBasis']>;
export type ReportRevenueMode = NonNullable<ReportBody['revenueMode']>;
export type ReportBucket = NonNullable<ReportBody['bucket']>;
export type ReportDatePreset = '24h' | '7d' | '30d' | '90d' | 'custom';

export const REPORT_ON_CHAIN_STATES = [
  'Pending',
  'FundsLocked',
  'FundsOrDatumInvalid',
  'ResultSubmitted',
  'RefundRequested',
  'Disputed',
  'WithdrawAuthorized',
  'RefundAuthorized',
  'Withdrawn',
  'RefundWithdrawn',
  'DisputedWithdrawn',
] as const satisfies readonly ReportOnChainState[];

export type TransactionReportViewDefaults = Readonly<{
  roles: readonly ReportRole[];
  states: readonly ReportOnChainState[];
  hasUnmappedFilters: boolean;
}>;

export type TransactionReportFormState = Readonly<{
  paymentSourceId: string;
  managedWalletIds: readonly string[];
  externalAddressesText: string;
  roles: readonly ReportRole[];
  states: readonly ReportOnChainState[];
  datePreset: ReportDatePreset;
  customStartDate: string;
  customEndDate: string;
  dateBasis: ReportDateBasis;
  revenueMode: ReportRevenueMode;
  bucket: ReportBucket;
  timeZone: string;
}>;

export type ReportBodyResult =
  | Readonly<{ body: ReportBody; error: null }>
  | Readonly<{ body: null; error: string }>;

type ReportWalletFacet = Readonly<{ id: string; paymentSourceId: string }>;

export function filterAccessibleReportWalletIds(
  selectedWalletIds: readonly string[],
  wallets: readonly ReportWalletFacet[],
  paymentSourceId: string,
): string[] {
  const accessibleIds = new Set(
    wallets
      .filter((wallet) => wallet.paymentSourceId === paymentSourceId)
      .map((wallet) => wallet.id),
  );
  return selectedWalletIds.filter((walletId) => accessibleIds.has(walletId));
}

type LocalDate = Readonly<{ year: number; month: number; day: number }>;

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const DATE_BOUNDARY_SEARCH_HOURS = 36;
const PRESET_MILLISECONDS: Record<Exclude<ReportDatePreset, 'custom'>, number> = {
  '24h': DAY_MILLISECONDS,
  '7d': 7 * DAY_MILLISECONDS,
  '30d': 30 * DAY_MILLISECONDS,
  '90d': 90 * DAY_MILLISECONDS,
};

function rolesForTransactionType(type: TransactionFilterState['type']): readonly ReportRole[] {
  if (type === 'payment') return ['Seller'];
  if (type === 'purchase') return ['Buyer'];
  return ['Buyer', 'Seller'];
}

export function buildTransactionReportViewDefaults(
  activeTab: string,
  filters: TransactionFilterState,
  hasSearchFilter: boolean,
): TransactionReportViewDefaults {
  const tabType =
    activeTab === 'Payments' ? 'payment' : activeTab === 'Purchases' ? 'purchase' : null;
  const tabState =
    activeTab === 'Refund Requests'
      ? 'RefundRequested'
      : activeTab === 'Disputes'
        ? 'Disputed'
        : null;

  return {
    roles: rolesForTransactionType(filters.type ?? tabType),
    states: filters.status ? [filters.status] : tabState ? [tabState] : [],
    hasUnmappedFilters:
      hasSearchFilter ||
      activeTab === 'Needs Action' ||
      filters.needsAction ||
      filters.errorType != null,
  };
}

export function getBrowserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC';
}

export function createTransactionReportForm(
  paymentSourceId: string,
  defaults: TransactionReportViewDefaults,
  timeZone = getBrowserTimeZone(),
): TransactionReportFormState {
  return {
    paymentSourceId,
    managedWalletIds: [],
    externalAddressesText: '',
    roles: [...defaults.roles],
    states: [...defaults.states],
    datePreset: '30d',
    customStartDate: '',
    customEndDate: '',
    dateBasis: 'RevenueRecognizedAt',
    revenueMode: 'Billable',
    bucket: 'Auto',
    timeZone,
  };
}

function splitExternalAddresses(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((address) => address.trim())
        .filter(Boolean),
    ),
  ];
}

function localDateOrdinal(date: LocalDate): number {
  const value = new Date(0);
  value.setUTCFullYear(date.year, date.month - 1, date.day);
  value.setUTCHours(0, 0, 0, 0);
  return value.getTime();
}

function localDateFromOrdinal(ordinal: number): LocalDate {
  const value = new Date(ordinal);
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  };
}

function parseDateOnly(value: string): LocalDate | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const parsed = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const normalized = localDateFromOrdinal(localDateOrdinal(parsed));
  return normalized.year === parsed.year &&
    normalized.month === parsed.month &&
    normalized.day === parsed.day
    ? parsed
    : null;
}

function createLocalDateReader(timeZone: string): (date: Date) => LocalDate {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    calendar: 'iso8601',
    numberingSystem: 'latn',
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return (date) => {
    const fields = new Map(
      formatter
        .formatToParts(date)
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, Number(part.value)]),
    );
    const year = fields.get('year');
    const month = fields.get('month');
    const day = fields.get('day');
    if (year == null || month == null || day == null) {
      throw new RangeError('Unable to read local report date');
    }
    return { year, month, day };
  };
}

function findLocalDateStart(localDate: LocalDate, readLocalDate: (date: Date) => LocalDate): Date {
  const targetOrdinal = localDateOrdinal(localDate);
  let low = targetOrdinal - DATE_BOUNDARY_SEARCH_HOURS * 60 * 60 * 1000;
  let high = targetOrdinal + DATE_BOUNDARY_SEARCH_HOURS * 60 * 60 * 1000;
  while (localDateOrdinal(readLocalDate(new Date(low))) >= targetOrdinal) low -= DAY_MILLISECONDS;
  while (localDateOrdinal(readLocalDate(new Date(high))) < targetOrdinal) high += DAY_MILLISECONDS;

  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    if (localDateOrdinal(readLocalDate(new Date(middle))) >= targetOrdinal) high = middle;
    else low = middle;
  }
  return new Date(high);
}

function resolveDateRange(
  form: TransactionReportFormState,
  now: Date,
): Readonly<{ from: Date; to: Date }> | null {
  if (form.datePreset !== 'custom') {
    return {
      from: new Date(now.getTime() - PRESET_MILLISECONDS[form.datePreset]),
      to: new Date(now),
    };
  }

  const selectedStart = parseDateOnly(form.customStartDate);
  const selectedEnd = parseDateOnly(form.customEndDate);
  if (!selectedStart || !selectedEnd) return null;
  try {
    const readLocalDate = createLocalDateReader(form.timeZone.trim());
    return {
      from: findLocalDateStart(selectedStart, readLocalDate),
      to: findLocalDateStart(
        localDateFromOrdinal(localDateOrdinal(selectedEnd) + DAY_MILLISECONDS),
        readLocalDate,
      ),
    };
  } catch {
    return null;
  }
}

export function buildTransactionReportBody(
  form: TransactionReportFormState,
  now = new Date(),
): ReportBodyResult {
  if (!form.paymentSourceId) return { body: null, error: 'Select a payment source.' };
  if (form.roles.length === 0) return { body: null, error: 'Select at least one role.' };
  if (!form.timeZone.trim()) return { body: null, error: 'Enter an IANA time zone.' };

  const range = resolveDateRange(form, now);
  if (!range) return { body: null, error: 'Select a valid custom date range.' };
  if (range.to.getTime() <= range.from.getTime()) {
    return { body: null, error: 'End date must be after start date.' };
  }

  const externalAddresses = splitExternalAddresses(form.externalAddressesText);
  if (externalAddresses.length > 100) {
    return { body: null, error: 'Use at most 100 external addresses.' };
  }

  return {
    error: null,
    body: {
      paymentSourceId: form.paymentSourceId,
      ...(form.managedWalletIds.length > 0 ? { managedWalletIds: [...form.managedWalletIds] } : {}),
      ...(externalAddresses.length > 0 ? { externalAddresses } : {}),
      roles: [...form.roles],
      ...(form.states.length > 0 ? { states: [...form.states] } : {}),
      from: range.from,
      to: range.to,
      dateBasis: form.dateBasis,
      revenueMode: form.revenueMode,
      timeZone: form.timeZone.trim(),
      bucket: form.bucket,
    },
  };
}

export function toggleReportFilterValue<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export function toggleReportWalletSelection(
  form: TransactionReportFormState,
  paymentSourceId: string,
  walletId: string,
): TransactionReportFormState {
  const currentWalletIds = form.paymentSourceId === paymentSourceId ? form.managedWalletIds : [];
  return {
    ...form,
    paymentSourceId,
    managedWalletIds: toggleReportFilterValue(currentWalletIds, walletId),
  };
}
