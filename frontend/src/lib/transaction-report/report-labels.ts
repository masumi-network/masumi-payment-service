import type { ReportMetricKey } from './dashboard-metrics';

/**
 * One place for every operator-facing metric name. The API field names are
 * accounting shorthand ("actorCardanoFees"), so the UI never shows them raw.
 *
 * Fee wording follows the server: `actorCardanoFees` is the reconciled buyer
 * plus seller share of the Cardano transaction fee, `adminCardanoFees` is the
 * remainder paid by the service's own wallets, and `totalCardanoFees` is both.
 */
export const REPORT_METRIC_LABELS = {
  sellerGrossRevenue: 'Gross revenue',
  sellerPendingRevenue: 'Not yet earned',
  protocolFees: 'Protocol fees',
  sellerCardanoFees: 'Seller network fees',
  sellerNetRevenue: 'Net revenue',
  buyerGrossSpend: 'Gross spend',
  returnedFunds: 'Refunds received',
  buyerCardanoFees: 'Buyer network fees',
  buyerNetSpend: 'Net spend',
  actorCardanoFees: 'Buyer and seller fees',
  adminCardanoFees: 'Admin fees',
  totalCardanoFees: 'Total network fees',
} as const satisfies Record<ReportMetricKey, string>;

/** Short line under a metric, shown where there is room for it. */
export const REPORT_METRIC_HINTS = {
  sellerGrossRevenue: 'Earned before any fee',
  sellerPendingRevenue: 'Locked in escrow, still to be earned',
  protocolFees: 'Kept by the payment source',
  sellerCardanoFees: 'Chain fees paid by selling wallets',
  sellerNetRevenue: 'Gross revenue minus fees',
  buyerGrossSpend: 'Paid out before refunds',
  returnedFunds: 'Came back from refunds',
  buyerCardanoFees: 'Chain fees paid by buying wallets',
  buyerNetSpend: 'Gross spend minus refunds and fees',
  actorCardanoFees: 'Chain fees split across both sides',
  adminCardanoFees: 'Chain fees paid by service wallets',
  totalCardanoFees: 'Every chain fee in this period',
} as const satisfies Record<ReportMetricKey, string>;

/**
 * Series colors reuse the accent tones already used by the dashboard stat
 * cards, so a chart and the card above it read as one palette. Fixed hex keeps
 * them legible in both themes; SVG presentation attributes cannot resolve the
 * theme's `var(--…)` tokens.
 */
export const REPORT_SERIES_COLORS = {
  revenue: 'rgb(34, 197, 94)',
  spend: 'rgb(59, 130, 246)',
  protocolFee: 'rgb(249, 115, 22)',
  networkFee: 'rgb(168, 85, 247)',
  refund: 'rgb(20, 184, 166)',
  admin: 'rgb(244, 63, 94)',
  /** Muted on purpose: this money is provisional, not earned. */
  pending: 'rgb(148, 163, 184)',
} as const;

export type ReportSeriesColor = (typeof REPORT_SERIES_COLORS)[keyof typeof REPORT_SERIES_COLORS];

/** Turns `RevenueRecognizedAt` into `Revenue recognized`. */
export function humanizeReportValue(value: string): string {
  const spaced = value.replace(/([A-Z])/g, ' $1').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/**
 * Filter vocabularies. The header, the filter bar, and the export dialog all
 * read these, so a period or a revenue rule is named the same way everywhere.
 */
export const REPORT_DATE_PRESET_LABELS = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  custom: 'Custom dates',
} as const;

export const REPORT_DATE_BASIS_LABELS = {
  RevenueRecognizedAt: 'When revenue was earned',
  FundsLockedAt: 'When funds were locked',
  CreatedAt: 'When the request was made',
} as const;

export const REPORT_DATE_BASIS_HINTS = {
  RevenueRecognizedAt: 'Counts a payment on the day it became earned.',
  FundsLockedAt: 'Counts a payment on the day it entered escrow.',
  CreatedAt: 'Counts a payment on the day it was requested.',
} as const;

export const REPORT_REVENUE_MODE_LABELS = {
  Billable: 'Earned',
  CashReceived: 'Paid out',
  RequestedGross: 'Requested',
} as const;

export const REPORT_REVENUE_MODE_HINTS = {
  Billable: 'Counts work once the escrow unlocks, even before withdrawal.',
  CashReceived: 'Counts only value that has actually been withdrawn.',
  RequestedGross: 'Counts every requested amount, settled or not.',
} as const;

export const REPORT_BUCKET_LABELS = {
  Auto: 'Automatic',
  Day: 'Daily',
  Week: 'Weekly',
  Month: 'Monthly',
} as const;
