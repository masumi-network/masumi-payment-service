import { Button } from '@/components/ui/button';
import { useCip30Wallet } from '@/lib/cip30/useCip30Wallet';
import { useGuardedPolicy } from '@/components/wallets/useGuardedPolicy';
import type { GuardedChain, GuardedRecord } from '@/components/wallets/guarded-policy-form';
import { GuardedHydraSection } from './GuardedHydraSection';
import { GuardedPolicyDialog } from './GuardedPolicyDialog';

/**
 * Wires the owner's actions (limits and deposit, Hydra moves) to one CIP-30
 * connection. Holds no state of its own.
 */
export function GuardedOwnerSection({
  hotWalletId,
  agentVkh,
  network,
  guarded,
  chain,
}: {
  hotWalletId: string;
  agentVkh: string;
  network: 'Preprod' | 'Mainnet';
  guarded: GuardedRecord;
  chain: GuardedChain | null;
}) {
  const ownerWallet = useCip30Wallet();
  const policy = useGuardedPolicy({ hotWalletId, network, guarded, chain, agentVkh, ownerWallet });

  return (
    <>
      <div className="flex items-center justify-between gap-3 rounded-lg border px-4 py-3">
        <div className="text-xs text-muted-foreground">
          The owner sets per-asset limits and deposits ADA or tokens. The wallet must be on L1.
        </div>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={policy.open}
          disabled={!policy.canOpen}
        >
          Limits and deposit
        </Button>
      </div>
      <GuardedPolicyDialog
        rows={policy.rows}
        isBusy={policy.isBusy}
        blockedReason={policy.blockedReason}
        onRowsChange={policy.setRows}
        onSubmit={() => void policy.submit()}
        onClose={policy.close}
      />
      <GuardedHydraSection
        hotWalletId={hotWalletId}
        ownerAddress={guarded.ownerAddress}
        network={network}
        ownerWallet={ownerWallet}
        guarded={guarded}
        agentVkh={agentVkh}
      />
    </>
  );
}
