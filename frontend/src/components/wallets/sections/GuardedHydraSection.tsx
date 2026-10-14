import { useGuardedHydra } from '@/components/wallets/useGuardedHydra';
import type { useCip30Wallet } from '@/lib/cip30/useCip30Wallet';
import { GuardedHydraPanel } from './GuardedHydraPanel';
import { OwnerWalletConnect } from './OwnerWalletConnect';

/** Wires useGuardedHydra to its views. Holds no state of its own. */
export function GuardedHydraSection({
  hotWalletId,
  ownerAddress,
  network,
  ownerWallet,
  guarded,
  agentVkh,
}: {
  hotWalletId: string;
  ownerAddress: string;
  network: 'Preprod' | 'Mainnet';
  ownerWallet: ReturnType<typeof useCip30Wallet>;
  guarded: { scriptAddress: string; policyId: string; stateTokenName: string };
  agentVkh: string;
}) {
  const hydra = useGuardedHydra({
    hotWalletId,
    ownerAddress,
    network,
    enabled: true,
    ownerWallet,
    guarded,
    agentVkh,
  });
  const problem = ownerWallet.signingProblem(network, ownerAddress);

  return (
    <GuardedHydraPanel
      network={network}
      state={hydra.state}
      isLoading={hydra.isLoading}
      loadError={hydra.loadError}
      openHeads={hydra.openHeads}
      blockedReason={problem}
      busy={hydra.busy}
      ownerWallet={
        <OwnerWalletConnect
          options={ownerWallet.options}
          connectedName={ownerWallet.connection?.name ?? null}
          isConnecting={ownerWallet.isConnecting}
          error={ownerWallet.error}
          problem={ownerWallet.connection == null ? null : problem}
          onDetect={ownerWallet.detect}
          onConnect={(id) => void ownerWallet.connect(id)}
          onDisconnect={ownerWallet.disconnect}
        />
      }
      onDeposit={(hydraHeadId) => void hydra.deposit(hydraHeadId)}
      onWithdraw={() => void hydra.withdraw()}
      onRecover={(transferId) => void hydra.recover(transferId)}
    />
  );
}
