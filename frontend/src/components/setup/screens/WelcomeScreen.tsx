import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowRight, Wallet, Key, Bot, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatNetworkDisplay } from '@/components/setup/setup-helpers';

export function WelcomeScreen({
  onStart,
  networkType,
}: {
  onStart: () => void;
  networkType: string;
}) {
  const networkDisplay = formatNetworkDisplay(networkType);

  const features = [
    { icon: Wallet, label: 'Create secure wallets' },
    { icon: Key, label: 'Configure V2 payment source' },
    { icon: Bot, label: 'Register your AI agent (optional)' },
  ];

  return (
    <Card className="w-full max-w-lg border shadow-xl bg-gradient-to-b from-card to-card/80 animate-scale-in-bounce">
      <CardHeader className="text-center pb-4 pt-8">
        <div className="mx-auto mb-6 relative">
          <div className="absolute inset-0 rounded-full bg-primary/20 blur-xl opacity-30" />
          <div className="relative flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-primary/20 to-primary/5 ring-1 ring-primary/20">
            <Sparkles className="h-8 w-8 text-primary" />
          </div>
        </div>
        <CardTitle className="text-3xl font-bold animate-fade-in-up">Welcome!</CardTitle>
        <CardDescription className="text-base mt-2 animate-fade-in-up animate-delay-75">
          Let&apos;s set up your{' '}
          <Badge variant="outline" className="font-medium text-foreground mx-1">
            {networkDisplay}
          </Badge>{' '}
          environment
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 pb-8">
        <div className="space-y-3">
          {features.map((feature, index) => (
            <div
              key={index}
              className={cn(
                'flex items-center gap-3 rounded-lg border bg-muted/30 px-4 py-3',
                'transition-colors duration-150 hover:bg-muted/50',
                'opacity-0 animate-slide-in-left',
                index === 0 && 'animate-delay-100',
                index === 1 && 'animate-delay-125',
                index === 2 && 'animate-delay-150',
              )}
              style={{ animationFillMode: 'forwards' }}
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10">
                <feature.icon className="h-4 w-4 text-primary" />
              </div>
              <span className="text-sm font-medium">{feature.label}</span>
            </div>
          ))}
        </div>
        <div
          className="pt-2 opacity-0 animate-fade-in-up animate-delay-225"
          style={{ animationFillMode: 'forwards' }}
        >
          <Button
            onClick={onStart}
            className="w-full gap-2 h-11 text-base btn-hover-lift group"
            size="lg"
          >
            Get started{' '}
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
