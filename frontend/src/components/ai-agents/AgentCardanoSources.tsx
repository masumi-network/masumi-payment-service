import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CopyButton } from '@/components/ui/copy-button';
import { cn, shortenAddress } from '@/lib/utils';
import { RegistryEntry } from '@/lib/api/generated';
import { formatFundUnit } from '@/lib/utils';

type SupportedPaymentSource = NonNullable<RegistryEntry['supportedPaymentSources']>[number];
type CardanoPaymentSource = Extract<SupportedPaymentSource, { chain: 'Cardano' }>;

export function agentHasCardanoSources(sources: RegistryEntry['supportedPaymentSources']): boolean {
  return (sources ?? []).some((source) => source.chain === 'Cardano');
}

export function AgentCardanoSources({
  sources,
}: {
  sources: RegistryEntry['supportedPaymentSources'];
}) {
  const cardanoSources = (sources ?? []).filter(
    (source): source is CardanoPaymentSource => source.chain === 'Cardano',
  );
  if (cardanoSources.length === 0) return null;

  const pricingLabel = (source: CardanoPaymentSource): string => {
    if (source.pricing.pricingType === 'Free') return 'Free';
    if (source.pricing.pricingType === 'Dynamic') return 'Dynamic per payment';
    return source.pricing.fixed
      .map(
        (price) => `${price.amount} ${formatFundUnit(price.asset || 'lovelace', source.network)}`,
      )
      .join(' · ');
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Cardano Payment Sources</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2 p-2 bg-muted/40 border rounded-md">
          {cardanoSources.map((source, index, arr) => (
            <div
              key={`${source.network}-${source.address}`}
              className={cn('flex flex-col gap-1 py-2', index < arr.length - 1 && 'border-b')}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">{source.network}</span>
                <Badge variant="outline">{pricingLabel(source)}</Badge>
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Settlement</span>
                <span>{source.paymentSourceType}</span>
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Escrow contract</span>
                <span className="font-mono flex items-center gap-1">
                  {shortenAddress(source.address, 8)}
                  <CopyButton value={source.address} />
                </span>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
