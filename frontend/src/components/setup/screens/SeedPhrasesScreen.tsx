import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import {
  Download,
  Copy,
  ArrowRight,
  Wallet,
  CheckCircle2,
  AlertTriangle,
  ShieldCheck,
  Eye,
  EyeOff,
} from 'lucide-react';
import { cn, shortenAddress } from '@/lib/utils';
import { useWalletGeneration } from '@/lib/hooks/useWalletGeneration';
import { copyToClipboard, type SetupWallet } from '@/components/setup/setup-helpers';

export function SeedPhrasesScreen({
  onNext,
  ignoreSetup,
}: {
  onNext: (buyingWallet: SetupWallet, sellingWallet: SetupWallet) => void;
  ignoreSetup: () => void;
}) {
  const { isGenerating, buyingWallet, sellingWallet, error } = useWalletGeneration();
  const [isConfirmed, setIsConfirmed] = useState(false);
  // Seed phrases are blurred by default. The user explicitly reveals to
  // copy/screenshot, which keeps mnemonics out of the DOM-visible tree
  // for casual screen-sharing / over-shoulder / screenshots taken while
  // navigating the rest of the wizard. Per-wallet flag because the user
  // may want to reveal one and not the other.
  const [showBuyingMnemonic, setShowBuyingMnemonic] = useState(false);
  const [showSellingMnemonic, setShowSellingMnemonic] = useState(false);

  return (
    <div className="space-y-6 w-full max-w-2xl">
      <div className="text-center space-y-3 animate-fade-in-up">
        <div className="inline-flex items-center justify-center rounded-full bg-gradient-to-br from-primary/20 to-primary/5 p-3 ring-1 ring-primary/20">
          <Wallet className="h-6 w-6 text-primary" />
        </div>
        <h1 className="text-2xl font-bold">Save your seed phrases</h1>
        <p className="text-sm text-muted-foreground max-w-md mx-auto">
          Store these phrases securely. You need them to access your wallets—we cannot recover them.
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-3 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive animate-fade-in-up">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <div
        className="rounded-xl border border-amber-500/30 bg-gradient-to-r from-amber-500/5 to-amber-500/10 px-4 py-4 flex gap-3 opacity-0 animate-slide-in-bottom animate-delay-75"
        style={{ animationFillMode: 'forwards' }}
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-amber-500/20 shrink-0">
          <ShieldCheck className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        </div>
        <div>
          <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
            Security reminder
          </p>
          <p className="text-sm text-amber-700/80 dark:text-amber-300/80 mt-0.5">
            Never share seed phrases or store them online. Anyone with a phrase can control that
            wallet.
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card
          className="overflow-hidden border-2 border-primary/10 bg-gradient-to-b from-primary/[0.02] to-transparent opacity-0 animate-slide-in-bottom animate-delay-100"
          style={{ animationFillMode: 'forwards' }}
        >
          <CardHeader className="pb-3 space-y-3">
            <div className="flex items-center justify-between">
              <Badge variant="secondary" className="gap-1.5 px-2.5">
                <Wallet className="h-3 w-3" /> Buying
              </Badge>
              {!isGenerating && buyingWallet && (
                <span className="text-xs text-green-600 dark:text-green-500 flex items-center gap-1 animate-pop-in">
                  <CheckCircle2 className="h-3 w-3" /> Generated
                </span>
              )}
            </div>
            <CardTitle className="text-base">Buying wallet</CardTitle>
            <CardDescription className="text-xs">
              Used to purchase AI agent services
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isGenerating ? (
              <div className="flex flex-col items-center justify-center py-8 gap-3">
                <Spinner size={24} />
                <span className="text-sm text-muted-foreground animate-pulse">
                  Generating wallet...
                </span>
              </div>
            ) : (
              buyingWallet && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2">
                    <span className="font-mono text-xs text-muted-foreground truncate flex-1">
                      {shortenAddress(buyingWallet.address, 12)}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0"
                      aria-label="Copy address"
                      onClick={() => copyToClipboard(buyingWallet.address)}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <Separator />
                  <div className="space-y-3">
                    <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Seed phrase
                    </p>
                    <div className="relative rounded-lg bg-muted/30 p-3 border border-dashed">
                      <p
                        className={cn(
                          'font-mono text-xs text-foreground/80 break-all leading-relaxed transition-[filter] select-none',
                          !showBuyingMnemonic && 'blur-md',
                        )}
                        aria-hidden={!showBuyingMnemonic}
                      >
                        {buyingWallet.mnemonic}
                      </p>
                      {!showBuyingMnemonic && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="absolute inset-0 m-auto h-7 w-fit px-3 gap-1.5"
                          onClick={() => setShowBuyingMnemonic(true)}
                        >
                          <Eye className="h-3.5 w-3.5" /> Reveal seed phrase
                        </Button>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => setShowBuyingMnemonic((v) => !v)}
                      >
                        {showBuyingMnemonic ? (
                          <>
                            <EyeOff className="h-3.5 w-3.5" /> Hide
                          </>
                        ) : (
                          <>
                            <Eye className="h-3.5 w-3.5" /> Show
                          </>
                        )}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5 flex-1"
                        onClick={() => copyToClipboard(buyingWallet.mnemonic)}
                      >
                        <Copy className="h-3.5 w-3.5" /> Copy
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5 flex-1"
                        onClick={() => {
                          // Explicit consent before writing a plaintext
                          // seed phrase to disk — the file persists with
                          // no encryption and survives until the user
                          // shreds it.
                          const ok = window.confirm(
                            'This downloads your seed phrase as an unencrypted .txt file. Anyone with access to the file can spend your funds. Continue?',
                          );
                          if (!ok) return;
                          const blob = new Blob([buyingWallet.mnemonic], {
                            type: 'text/plain',
                          });
                          const url = window.URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = 'buying-wallet-seed.txt';
                          a.click();
                          window.URL.revokeObjectURL(url);
                        }}
                      >
                        <Download className="h-3.5 w-3.5" /> Download
                      </Button>
                    </div>
                  </div>
                </div>
              )
            )}
          </CardContent>
        </Card>

        <Card
          className="overflow-hidden border-2 border-orange-500/20 bg-gradient-to-b from-orange-500/[0.03] to-transparent opacity-0 animate-slide-in-bottom animate-delay-125"
          style={{ animationFillMode: 'forwards' }}
        >
          <CardHeader className="pb-3 space-y-3">
            <div className="flex items-center justify-between">
              <Badge className="gap-1.5 px-2.5 bg-orange-600 hover:bg-orange-600">
                <Wallet className="h-3 w-3" /> Selling
              </Badge>
              {!isGenerating && sellingWallet && (
                <span className="text-xs text-green-600 dark:text-green-500 flex items-center gap-1 animate-pop-in">
                  <CheckCircle2 className="h-3 w-3" /> Generated
                </span>
              )}
            </div>
            <CardTitle className="text-base">Selling wallet</CardTitle>
            <CardDescription className="text-xs">
              Receives payments for your AI agents
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isGenerating ? (
              <div className="flex flex-col items-center justify-center py-8 gap-3">
                <Spinner size={24} />
                <span className="text-sm text-muted-foreground animate-pulse">
                  Generating wallet...
                </span>
              </div>
            ) : (
              sellingWallet && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2">
                    <span className="font-mono text-xs text-muted-foreground truncate flex-1">
                      {shortenAddress(sellingWallet.address, 12)}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0"
                      aria-label="Copy address"
                      onClick={() => copyToClipboard(sellingWallet.address)}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <Separator />
                  <div className="space-y-3">
                    <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Seed phrase
                    </p>
                    <div className="relative rounded-lg bg-muted/30 p-3 border border-dashed">
                      <p
                        className={cn(
                          'font-mono text-xs text-foreground/80 break-all leading-relaxed transition-[filter] select-none',
                          !showSellingMnemonic && 'blur-md',
                        )}
                        aria-hidden={!showSellingMnemonic}
                      >
                        {sellingWallet.mnemonic}
                      </p>
                      {!showSellingMnemonic && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="absolute inset-0 m-auto h-7 w-fit px-3 gap-1.5"
                          onClick={() => setShowSellingMnemonic(true)}
                        >
                          <Eye className="h-3.5 w-3.5" /> Reveal seed phrase
                        </Button>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => setShowSellingMnemonic((v) => !v)}
                      >
                        {showSellingMnemonic ? (
                          <>
                            <EyeOff className="h-3.5 w-3.5" /> Hide
                          </>
                        ) : (
                          <>
                            <Eye className="h-3.5 w-3.5" /> Show
                          </>
                        )}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5 flex-1"
                        onClick={() => copyToClipboard(sellingWallet.mnemonic)}
                      >
                        <Copy className="h-3.5 w-3.5" /> Copy
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5 flex-1"
                        onClick={() => {
                          // Explicit consent before writing a plaintext
                          // seed phrase to disk — see buying-wallet block
                          // for full rationale.
                          const ok = window.confirm(
                            'This downloads your seed phrase as an unencrypted .txt file. Anyone with access to the file can spend your funds. Continue?',
                          );
                          if (!ok) return;
                          const blob = new Blob([sellingWallet.mnemonic], {
                            type: 'text/plain',
                          });
                          const url = window.URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = 'selling-wallet-seed.txt';
                          a.click();
                          window.URL.revokeObjectURL(url);
                        }}
                      >
                        <Download className="h-3.5 w-3.5" /> Download
                      </Button>
                    </div>
                  </div>
                </div>
              )
            )}
          </CardContent>
        </Card>
      </div>

      <Card
        className="border-2 opacity-0 animate-slide-in-bottom animate-delay-175"
        style={{ animationFillMode: 'forwards' }}
      >
        <CardContent className="pt-6 pb-6">
          <div
            className={cn(
              'flex items-start gap-3 p-4 rounded-lg border transition-all duration-200',
              isConfirmed ? 'bg-green-500/5 border-green-500/30' : 'bg-muted/30 border-border',
            )}
          >
            <Checkbox
              id="confirm"
              checked={isConfirmed}
              onCheckedChange={(checked) => setIsConfirmed(checked as boolean)}
              disabled={isGenerating}
              className="mt-0.5"
            />
            <Label
              htmlFor="confirm"
              className="text-sm text-muted-foreground cursor-pointer leading-relaxed"
            >
              I have saved both seed phrases in a secure place and understand they cannot be
              recovered if lost.
            </Label>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3 pt-6">
            <Button variant="ghost" onClick={ignoreSetup} className="transition-all hover:bg-muted">
              Cancel
            </Button>
            <Button
              disabled={isGenerating || !isConfirmed || !buyingWallet || !sellingWallet}
              onClick={() => {
                if (buyingWallet && sellingWallet) {
                  onNext(buyingWallet, sellingWallet);
                }
              }}
              className="gap-2 min-w-[140px] btn-hover-lift group"
              size="lg"
            >
              {isGenerating ? (
                <>
                  <Spinner size={16} /> Generating...
                </>
              ) : (
                <>
                  Continue{' '}
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
