import { useId, useState } from 'react';
import { CheckCircle2, Download, Fuel } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SetupStepActions, SetupStepHeader } from '@/components/setup/wizard/SetupStepParts';
import { RadioCardGroup } from '@/components/x402/setup/RadioCardGroup';
import { X402WalletCreator } from '@/components/x402/setup/X402WalletCreator';
import type { X402SetupController } from '@/components/x402/setup/useX402SetupController';
import type { X402Wallet } from '@/lib/api/generated';
import { shortenAddress } from '@/lib/utils';
import { X402_ACCENT } from '@/lib/x402-rail';
import { inferX402ReceiveMode, type X402ReceiveMode } from '@/lib/x402-setup';

const HTTPS_URL_ERROR = 'Enter a URL that starts with https://';

function walletLabel(wallet: Pick<X402Wallet, 'note' | 'address'>) {
  const address = shortenAddress(wallet.address, 6);
  return wallet.note ? `${wallet.note} · ${address}` : address;
}

function isHttpsUrl(value: string) {
  try {
    return new URL(value.trim()).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Gas hint for node mode: the Selling wallet submits each settlement and pays its gas. */
function GasNote({ chainName }: { chainName: string }) {
  return (
    <p className="flex items-start gap-2 text-pretty text-xs leading-snug text-muted-foreground">
      <Fuel className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      Your Selling wallet sends each settlement on {chainName} and pays its gas. Keep some of the
      chain&apos;s native gas token on it (ETH on Base).
    </p>
  );
}

/**
 * Step 2: decide who settles incoming payments and switch receiving on, all on this screen.
 * Node mode picks or creates a Selling wallet; remote mode takes a facilitator URL. Either
 * way one write assigns the facilitator and enables the chain.
 */
export function X402ReceiveStep({ controller }: { controller: X402SetupController }) {
  const {
    selectedChain,
    sellingWallets,
    facilitatorWallet,
    isReceivingReady,
    isEnablingReceiving,
    enableReceiving,
    goToStep,
    goAfterReceive,
  } = controller;
  const [isChanging, setIsChanging] = useState(false);
  const [isBackingUpKey, setIsBackingUpKey] = useState(false);
  const [mode, setMode] = useState<X402ReceiveMode>(() =>
    selectedChain ? inferX402ReceiveMode(selectedChain) : 'node',
  );
  const [walletId, setWalletId] = useState<string | null>(
    () => facilitatorWallet?.id ?? sellingWallets[0]?.id ?? null,
  );
  const [facilitatorUrl, setFacilitatorUrl] = useState(selectedChain?.facilitatorUrl ?? '');
  const [facilitatorAuth, setFacilitatorAuth] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);
  const modeLabelId = useId();
  const walletLabelId = useId();
  const urlId = useId();
  const urlErrorId = useId();
  const authId = useId();
  const authHintId = useId();

  if (!selectedChain) return null;
  const chainName = selectedChain.displayName;
  const hasStoredRemote = !!selectedChain.facilitatorUrl;
  const pickedWalletId = sellingWallets.some((wallet) => wallet.id === walletId)
    ? walletId
    : (sellingWallets[0]?.id ?? null);
  const isShowingSummary = isReceivingReady && !isChanging;

  const enable = async (receiver: Parameters<typeof enableReceiving>[0]) => {
    if (await enableReceiving(receiver)) setIsChanging(false);
  };

  const submitRemote = (event: React.FormEvent) => {
    event.preventDefault();
    if (!isHttpsUrl(facilitatorUrl)) {
      setUrlError(HTTPS_URL_ERROR);
      return;
    }
    setUrlError(null);
    void enable({ mode: 'remote', facilitatorUrl, facilitatorAuth });
  };

  const summary = (
    <div className="space-y-3 rounded-xl border border-green-500/25 bg-green-500/[0.04] p-4">
      <p className="flex items-center gap-2 text-sm font-medium text-green-700 dark:text-green-500">
        <CheckCircle2 className="size-4" aria-hidden />
        Receiving is on for {chainName}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Settled by</dt>
        <dd className="min-w-0 truncate">
          {selectedChain.facilitatorUrl ? (
            <span className="font-mono text-xs" title={selectedChain.facilitatorUrl}>
              {selectedChain.facilitatorUrl}
            </span>
          ) : facilitatorWallet ? (
            <span className="font-mono text-xs" title={facilitatorWallet.address}>
              {walletLabel(facilitatorWallet)}
            </span>
          ) : selectedChain.facilitatorWalletAddress ? (
            <span className="font-mono text-xs">
              {shortenAddress(selectedChain.facilitatorWalletAddress, 6)}
            </span>
          ) : (
            'Your Selling wallet'
          )}
        </dd>
      </dl>
      {!selectedChain.facilitatorUrl && <GasNote chainName={chainName} />}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          setMode(inferX402ReceiveMode(selectedChain));
          setIsChanging(true);
        }}
      >
        Change who settles
      </Button>
    </div>
  );

  const nodePanel =
    sellingWallets.length === 0 || isBackingUpKey ? (
      <div className="space-y-3 rounded-xl border p-4">
        <div>
          <p className="text-sm font-medium">Create a Selling wallet on {chainName}</p>
          <p className="text-pretty text-xs text-muted-foreground">
            This wallet settles incoming payments. Receiving turns on after you back up its key.
          </p>
        </div>
        <X402WalletCreator
          chainId={selectedChain.id}
          type="Selling"
          createLabel="Create Selling wallet"
          readyLabel="Enable receiving"
          isFinishing={isEnablingReceiving}
          onBackupPendingChange={setIsBackingUpKey}
          onReady={(wallet) => void enable({ mode: 'node', sellingWalletId: wallet.id })}
        />
      </div>
    ) : (
      <div className="space-y-3 rounded-xl border p-4">
        <p id={walletLabelId} className="text-sm font-medium">
          Selling wallet
        </p>
        <RadioCardGroup
          labelledBy={walletLabelId}
          value={pickedWalletId}
          onChange={setWalletId}
          options={sellingWallets.map((wallet) => ({
            value: wallet.id,
            title: <span className="font-mono text-xs">{walletLabel(wallet)}</span>,
            aside:
              wallet.id === selectedChain.facilitatorWalletId ? (
                <Badge variant="outline">Current</Badge>
              ) : undefined,
          }))}
        />
        <GasNote chainName={chainName} />
        <Button
          type="button"
          className="w-full"
          disabled={!pickedWalletId || isEnablingReceiving}
          onClick={() =>
            pickedWalletId && void enable({ mode: 'node', sellingWalletId: pickedWalletId })
          }
        >
          {isEnablingReceiving ? 'Enabling…' : 'Enable receiving'}
        </Button>
      </div>
    );

  const remotePanel = (
    <form onSubmit={submitRemote} noValidate className="space-y-4 rounded-xl border p-4">
      <div className="space-y-1.5">
        <Label htmlFor={urlId}>Facilitator URL</Label>
        <Input
          id={urlId}
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://facilitator.example.com"
          value={facilitatorUrl}
          aria-invalid={!!urlError}
          aria-describedby={urlError ? urlErrorId : undefined}
          onChange={(event) => {
            setFacilitatorUrl(event.target.value);
            if (urlError) setUrlError(null);
          }}
        />
        {urlError && (
          <p id={urlErrorId} className="text-xs text-destructive">
            {urlError}
          </p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={authId}>Authorization header (optional)</Label>
        <Input
          id={authId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={hasStoredRemote ? 'Blank keeps the stored header' : 'Bearer …'}
          value={facilitatorAuth}
          aria-describedby={authHintId}
          onChange={(event) => setFacilitatorAuth(event.target.value)}
        />
        <p id={authHintId} className="text-pretty text-xs text-muted-foreground">
          Sent with every verify and settle request. It is stored encrypted and never shown again.
          {hasStoredRemote &&
            ' A different host clears the stored header. To remove it, edit the chain on Payment sources.'}
        </p>
      </div>
      <Button type="submit" className="w-full" disabled={isEnablingReceiving}>
        {isEnablingReceiving ? 'Enabling…' : 'Enable receiving'}
      </Button>
    </form>
  );

  return (
    <div className="mx-auto w-full max-w-lg space-y-6">
      <SetupStepHeader
        icon={Download}
        iconClassName={X402_ACCENT.icon}
        iconRingClassName={X402_ACCENT.iconRing}
        title="Receive payments"
        description={`Choose who settles the payments your agents receive on ${chainName}.`}
      />

      {isShowingSummary ? (
        summary
      ) : (
        <>
          <div className="space-y-2">
            <p id={modeLabelId} className="text-sm font-medium">
              Who settles payments
            </p>
            <RadioCardGroup
              labelledBy={modeLabelId}
              value={mode}
              onChange={setMode}
              columns={2}
              isDisabled={isBackingUpKey}
              options={[
                {
                  value: 'node',
                  title: 'Your Selling wallet',
                  description: 'This node settles each payment itself. No third party.',
                  aside: <Badge variant="secondary">Recommended</Badge>,
                },
                {
                  value: 'remote',
                  title: 'Remote facilitator',
                  description: 'An external HTTPS service checks and settles payments for you.',
                },
              ]}
            />
          </div>
          {mode === 'node' ? nodePanel : remotePanel}
          {isChanging && !isBackingUpKey && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full text-muted-foreground"
              onClick={() => setIsChanging(false)}
            >
              Keep the current setup
            </Button>
          )}
        </>
      )}

      <SetupStepActions
        // Leaving now would drop the only copy of the new key.
        onBack={isBackingUpKey ? undefined : () => goToStep(1)}
        primaryLabel="Continue"
        onPrimary={goAfterReceive}
        isPrimaryDisabled={!isShowingSummary || isBackingUpKey}
        blockedReason={
          isBackingUpKey
            ? 'Confirm the key backup above to continue.'
            : isReceivingReady
              ? 'Save or keep the current setup to continue.'
              : 'Enable receiving to continue.'
        }
      />
    </div>
  );
}
