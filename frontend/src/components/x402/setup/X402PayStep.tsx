import { useState } from 'react';
import { CheckCircle2, Coins, Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SetupStepActions, SetupStepHeader } from '@/components/setup/wizard/SetupStepParts';
import { X402WalletCreator } from '@/components/x402/setup/X402WalletCreator';
import type { X402SetupController } from '@/components/x402/setup/useX402SetupController';
import { shortenAddress } from '@/lib/utils';
import { X402_ACCENT } from '@/lib/x402-rail';
import { X402_SETUP_STEPS } from '@/lib/x402-setup';

/**
 * Step 3 (optional): a Purchasing wallet lets agents pay other x402 resources. An existing
 * wallet on the chain is shown instead of asking again; skipping keeps the rail receive-only.
 */
export function X402PayStep({ controller }: { controller: X402SetupController }) {
  const { selectedChain, purchasingWallets, goToStep, refresh } = controller;
  const [isAdding, setIsAdding] = useState(false);
  const [isBackingUpKey, setIsBackingUpKey] = useState(false);
  if (!selectedChain) return null;

  const chainName = selectedChain.displayName;
  const hasWallet = purchasingWallets.length > 0;
  const showCreator = !hasWallet || isAdding || isBackingUpKey;

  return (
    <div className="mx-auto w-full max-w-lg space-y-6">
      <SetupStepHeader
        icon={Coins}
        iconClassName={X402_ACCENT.icon}
        iconRingClassName={X402_ACCENT.iconRing}
        title="Pay other agents"
        badge={<Badge variant="secondary">Optional</Badge>}
        description={`A Purchasing wallet pays for x402 resources your agents use on ${chainName}. Skip this if your agents only sell.`}
      />

      {hasWallet && (
        <div className="space-y-3 rounded-xl border border-green-500/25 bg-green-500/[0.04] p-4">
          <p className="flex items-center gap-2 text-sm font-medium text-green-700 dark:text-green-500">
            <CheckCircle2 className="size-4" aria-hidden />
            {purchasingWallets.length === 1
              ? 'Purchasing wallet ready'
              : `${purchasingWallets.length} Purchasing wallets ready`}
          </p>
          <ul className="space-y-1">
            {purchasingWallets.map((wallet) => (
              <li key={wallet.id} className="truncate font-mono text-xs" title={wallet.address}>
                {wallet.note ? `${wallet.note} · ` : ''}
                {shortenAddress(wallet.address, 6)}
              </li>
            ))}
          </ul>
          <p className="text-pretty text-xs text-muted-foreground">
            Fund it with the settlement token and a little of the chain&apos;s gas token. Payments
            use Permit2, which needs a one-time token approval on-chain. After that the wallet only
            signs, and the seller&apos;s facilitator pays the gas to settle.
          </p>
          {!isAdding && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => setIsAdding(true)}
            >
              <Plus className="size-3.5" aria-hidden />
              Add another
            </Button>
          )}
        </div>
      )}

      {showCreator && (
        <div className="space-y-3 rounded-xl border p-4">
          <div>
            <p className="text-sm font-medium">Create a Purchasing wallet on {chainName}</p>
            <p className="text-pretty text-xs text-muted-foreground">
              After it is created, send it the settlement token and a little of the chain&apos;s gas
              token for the one-time Permit2 approval.
            </p>
          </div>
          <X402WalletCreator
            chainId={selectedChain.id}
            type="Purchasing"
            createLabel="Create Purchasing wallet"
            readyLabel="Done"
            onBackupPendingChange={setIsBackingUpKey}
            onReady={() => {
              setIsAdding(false);
              void refresh();
            }}
          />
          {hasWallet && !isBackingUpKey && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full text-muted-foreground"
              onClick={() => setIsAdding(false)}
            >
              Cancel
            </Button>
          )}
        </div>
      )}

      <SetupStepActions
        // Leaving now would drop the only copy of the new key.
        onBack={isBackingUpKey ? undefined : () => goToStep(X402_SETUP_STEPS.receive)}
        primaryLabel={hasWallet ? 'Continue' : 'Skip for now'}
        onPrimary={() => goToStep(X402_SETUP_STEPS.ready)}
        isPrimaryDisabled={isBackingUpKey}
        blockedReason="Confirm the key backup above to continue."
      />
    </div>
  );
}
