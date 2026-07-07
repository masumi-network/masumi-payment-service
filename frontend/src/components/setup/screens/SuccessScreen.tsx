import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowRight, Wallet, Key, Bot, CheckCircle2, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatNetworkDisplay } from '@/components/setup/setup-helpers';

export function SuccessScreen({
  onComplete,
  networkType,
  hasAiAgent = false,
}: {
  onComplete: () => void;
  networkType: string;
  hasAiAgent?: boolean;
}) {
  const networkDisplay = formatNetworkDisplay(networkType);

  const completedItems = [
    { label: 'Wallets created and secured', icon: Wallet },
    { label: 'Payment source configured', icon: Key },
    ...(hasAiAgent ? [{ label: 'First AI agent registered', icon: Bot }] : []),
  ];

  return (
    <Card className="w-full max-w-lg border shadow-xl bg-gradient-to-b from-card to-card/80 overflow-hidden animate-scale-in-bounce">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-green-500/50 to-transparent" />
      <CardHeader className="text-center pb-4 pt-10">
        <div className="mx-auto mb-6 relative animate-fade-in-up">
          <div className="absolute inset-0 rounded-full bg-green-500/10 blur-xl" />
          <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-green-500/20 to-green-600/10 ring-2 ring-green-500/30">
            <CheckCircle2 className="h-10 w-10 text-green-600 dark:text-green-500" />
          </div>
        </div>
        <CardTitle
          className="text-3xl font-bold animate-fade-in-up animate-delay-75"
          style={{ animationFillMode: 'forwards' }}
        >
          You&apos;re all set!
        </CardTitle>
        <CardDescription
          className="text-base mt-2 opacity-0 animate-fade-in-up animate-delay-100"
          style={{ animationFillMode: 'forwards' }}
        >
          Your{' '}
          <Badge variant="outline" className="font-medium text-foreground mx-1">
            {networkDisplay}
          </Badge>{' '}
          environment is ready to use
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 pb-8">
        <div className="space-y-3">
          {completedItems.map((item, index) => (
            <div
              key={index}
              className={cn(
                'flex items-center gap-3 rounded-lg border border-green-500/20 bg-green-500/5 px-4 py-3',
                'opacity-0 animate-slide-in-bottom',
                index === 0 && 'animate-delay-125',
                index === 1 && 'animate-delay-150',
                index === 2 && 'animate-delay-175',
              )}
              style={{ animationFillMode: 'forwards' }}
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-green-500/10">
                <Check className="h-4 w-4 text-green-600 dark:text-green-500" />
              </div>
              <span className="text-sm font-medium">{item.label}</span>
            </div>
          ))}
        </div>

        <div
          className="rounded-lg border bg-muted/30 px-4 py-3 opacity-0 animate-fade-in animate-delay-225"
          style={{ animationFillMode: 'forwards' }}
        >
          <p className="text-sm text-muted-foreground text-center">
            Head to the dashboard to manage payment sources, agents, and transactions.
          </p>
        </div>

        <div
          className="pt-2 opacity-0 animate-fade-in-up animate-delay-275"
          style={{ animationFillMode: 'forwards' }}
        >
          <Button
            onClick={onComplete}
            className="w-full gap-2 h-11 text-base btn-hover-lift group"
            size="lg"
          >
            Go to dashboard{' '}
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
