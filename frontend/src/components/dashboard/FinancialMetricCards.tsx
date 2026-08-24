import type { PostReportsSummaryResponses } from '@/lib/api/generated';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  formatReportMetricValue,
  getEmptyReportAssetLabel,
  getReportAssetDescriptor,
  type ReportAssetDescriptor,
  type ReportMetric,
  type ReportMetricKey,
} from '@/lib/transaction-report/dashboard-metrics';

type ReportSummary = PostReportsSummaryResponses[200]['data'];
type ReportRole = ReportSummary['wallets'][number]['role'];

type MetricCardDefinition = Readonly<{
  key: ReportMetricKey;
  label: string;
  unitType: 'business' | 'cardano';
  net?: boolean;
}>;

const SELLER_CARDS: readonly MetricCardDefinition[] = [
  { key: 'sellerGrossRevenue', label: 'Seller gross revenue', unitType: 'business' },
  { key: 'protocolFees', label: 'Protocol fees', unitType: 'business' },
  { key: 'sellerCardanoFees', label: 'Seller Cardano fees', unitType: 'cardano' },
  { key: 'sellerNetRevenue', label: 'Seller net revenue', unitType: 'business', net: true },
];

const BUYER_CARDS: readonly MetricCardDefinition[] = [
  { key: 'buyerGrossSpend', label: 'Buyer gross spend', unitType: 'business' },
  { key: 'returnedFunds', label: 'Returned funds', unitType: 'business' },
  { key: 'buyerCardanoFees', label: 'Buyer Cardano fees', unitType: 'cardano' },
  { key: 'buyerNetSpend', label: 'Buyer net spend', unitType: 'business', net: true },
];

const RECONCILIATION_CARDS: readonly MetricCardDefinition[] = [
  { key: 'actorCardanoFees', label: 'Reconciled actor fees', unitType: 'cardano' },
  { key: 'adminCardanoFees', label: 'Admin Cardano fees', unitType: 'cardano' },
  { key: 'totalCardanoFees', label: 'Total Cardano fees', unitType: 'cardano' },
];

function MetricValue({
  descriptor,
  isNet,
  metric,
}: Readonly<{
  descriptor: ReportAssetDescriptor | null;
  isNet: boolean;
  metric: ReportMetric;
}>) {
  if (!descriptor) {
    return (
      <div>
        <p className="text-lg font-semibold text-muted-foreground">
          {getEmptyReportAssetLabel(metric.completeness)}
        </p>
        {metric.completeness === 'partial' && (
          <Badge variant="warning" className="mt-2">
            Partial
          </Badge>
        )}
      </div>
    );
  }

  const display = formatReportMetricValue(metric, descriptor.unit, descriptor);

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="break-all font-mono text-xl font-semibold tabular-nums">
          {display.text}
        </span>
        {display.isPartial && <Badge variant="warning">Partial</Badge>}
      </div>
      {isNet && display.isNegative && (
        <p className="mt-1 text-xs font-medium text-destructive">Negative net</p>
      )}
    </div>
  );
}

function metricAmountForUnit(
  metric: ReportMetric,
  unit: string,
): ReportMetric['amounts'][number] | undefined {
  return metric.amounts.find((amount) => amount.unit === unit);
}

function FinancialMetricCard({
  definition,
  descriptor,
  metric,
}: Readonly<{
  definition: MetricCardDefinition;
  descriptor: ReportAssetDescriptor | null;
  metric: ReportMetric;
}>) {
  const amount = descriptor ? metricAmountForUnit(metric, descriptor.unit) : undefined;
  const scopedMetric = { ...metric, amounts: amount ? [amount] : [] };

  return (
    <Card className="shadow-none">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {definition.label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <MetricValue
          descriptor={descriptor}
          isNet={definition.net ?? false}
          metric={scopedMetric}
        />
      </CardContent>
    </Card>
  );
}

function MetricRow({
  definitions,
  summary,
  businessDescriptor,
  cardanoDescriptor,
}: Readonly<{
  definitions: readonly MetricCardDefinition[];
  summary: ReportSummary;
  businessDescriptor: ReportAssetDescriptor | null;
  cardanoDescriptor: ReportAssetDescriptor;
}>) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {definitions.map((definition) => (
        <FinancialMetricCard
          key={definition.key}
          definition={definition}
          descriptor={definition.unitType === 'cardano' ? cardanoDescriptor : businessDescriptor}
          metric={summary.totals[definition.key]}
        />
      ))}
    </div>
  );
}

export function FinancialMetricCards({
  summary,
  roles,
  selectedUnit,
}: Readonly<{
  summary: ReportSummary;
  roles: readonly ReportRole[];
  selectedUnit: string | null;
}>) {
  const roleSet = new Set(roles);
  const businessDescriptor = selectedUnit ? getReportAssetDescriptor(summary, selectedUnit) : null;
  const cardanoDescriptor = getReportAssetDescriptor(summary, 'lovelace');

  return (
    <div className="space-y-3">
      {roleSet.has('Seller') && (
        <MetricRow
          definitions={SELLER_CARDS}
          summary={summary}
          businessDescriptor={businessDescriptor}
          cardanoDescriptor={cardanoDescriptor}
        />
      )}
      {roleSet.has('Buyer') && (
        <MetricRow
          definitions={BUYER_CARDS}
          summary={summary}
          businessDescriptor={businessDescriptor}
          cardanoDescriptor={cardanoDescriptor}
        />
      )}
      <div className="grid gap-3 border-t pt-3 sm:grid-cols-3">
        {RECONCILIATION_CARDS.map((definition) => (
          <FinancialMetricCard
            key={definition.key}
            definition={definition}
            descriptor={cardanoDescriptor}
            metric={summary.totals[definition.key]}
          />
        ))}
      </div>
    </div>
  );
}
