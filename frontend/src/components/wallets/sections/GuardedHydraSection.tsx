import { useGuardedHydra } from '@/components/wallets/useGuardedHydra';
import { GuardedHydraPanel } from './GuardedHydraPanel';
import { OwnerWalletConnect } from './OwnerWalletConnect';

/** Wires useGuardedHydra to its views. Holds no state of its own. */
export function GuardedHydraSection({
  hotWalletId,
  ownerAddress,
  network,
}: {
  hotWalletId: string;
  ownerAddress: string;
  network: 'Preprod' | 'Mainnet';
}) {
  const hydra = useGuardedHydra({ hotWalletId, ownerAddress, network, enabled: true });
  const { ownerWallet } = hydra;
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
