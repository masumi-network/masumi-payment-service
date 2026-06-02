import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, shortenAddress, formatX402Amount } from '@/lib/utils';
import { useX402Networks } from '@/lib/hooks/useX402';
import { RegistryEntry } from '@/lib/api/generated';

type SupportedPaymentSource = NonNullable<RegistryEntry['supportedPaymentSources']>[number];
type EvmPaymentSource = Extract<SupportedPaymentSource, { chain: 'EVM' }>;

export function agentHasX402Options(sources: RegistryEntry['supportedPaymentSources']): boolean {
  return (sources ?? []).some((source) => source.chain === 'EVM');
}

export function AgentX402Options({
  sources,
}: {
  sources: RegistryEntry['supportedPaymentSources'];
}) {
  const { networks } = useX402Networks({ silentErrors: true });
  const evmSources = (sources ?? []).filter(
    (source): source is EvmPaymentSource => source.chain === 'EVM',
  );

  if (evmSources.length === 0) return null;

  const chainLabel = (caip2: string) =>
    networks.find((network) => network.caip2Id === caip2)?.displayName ?? caip2;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">x402 Payment Options</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2 p-2 bg-muted/40 border rounded-md">
          {evmSources.map((source, index, arr) => (
            <div
              key={`${source.network}-${source.asset}-${source.payTo}`}
              className={cn('flex flex-col gap-1 py-2', index < arr.length - 1 && 'border-b')}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">{chainLabel(source.network)}</span>
                <span className="font-medium font-mono">
                  {formatX402Amount(source.amount, source.decimals)} ·{' '}
                  {shortenAddress(source.asset, 6)}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Pay to</span>
                <span className="font-mono">{shortenAddress(source.payTo, 6)}</span>
              </div>
              {source.resource && (
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Resource</span>
                  <span className="font-mono truncate max-w-[220px]" title={source.resource}>
                    {source.resource}
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
