import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getAgentTypeLabel } from '@/lib/agent-type';
import type { AgentFormValues } from './register-agent-schema';

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 border-b last:border-b-0">
      <span className="text-sm text-muted-foreground shrink-0">{label}</span>
      <span className="text-sm text-right break-words">{value}</span>
    </div>
  );
}

export function RegisterAgentReviewSection({
  values,
  mintingWalletLabel,
  holdingWalletLabel,
  masumiOptionCount,
  x402OptionCount,
  verificationCount,
  pricingSummary,
}: {
  values: AgentFormValues;
  mintingWalletLabel: string;
  holdingWalletLabel: string;
  masumiOptionCount: number;
  x402OptionCount: number;
  verificationCount: number;
  pricingSummary: string;
}) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Agent details</CardTitle>
        </CardHeader>
        <CardContent className="px-3 bg-muted/40 border rounded-md mx-6 mb-4">
          <SummaryRow label="Name" value={values.name} />
          <SummaryRow label="Type" value={getAgentTypeLabel(values.agentType)} />
          <SummaryRow label="Description" value={values.description || '—'} />
          {values.agentType === 'Standard' && values.apiUrl && (
            <SummaryRow label="API URL" value={values.apiUrl} />
          )}
          {values.agentType === 'OpenApi' && values.openApiSpecUrl && (
            <SummaryRow label="OpenAPI spec" value={values.openApiSpecUrl} />
          )}
          {values.agentType === 'X402' && values.x402ResourcesUrl && (
            <SummaryRow label="x402 resources" value={values.x402ResourcesUrl} />
          )}
          <SummaryRow label="Tags" value={values.tags.length ? values.tags.join(', ') : '—'} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Wallets & pricing</CardTitle>
        </CardHeader>
        <CardContent className="px-3 bg-muted/40 border rounded-md mx-6 mb-4">
          <SummaryRow label="Minting wallet" value={mintingWalletLabel} />
          <SummaryRow label="Holding wallet" value={holdingWalletLabel} />
          {values.sendFundingAda ? (
            <SummaryRow label="Holding wallet funding" value={`${values.sendFundingAda} ADA`} />
          ) : null}
          <SummaryRow label="Pricing" value={pricingSummary} />
          <SummaryRow
            label="Payment options"
            value={`${masumiOptionCount} Masumi · ${x402OptionCount} x402`}
          />
          {verificationCount > 0 ? (
            <SummaryRow label="Verifications" value={`${verificationCount} configured`} />
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
