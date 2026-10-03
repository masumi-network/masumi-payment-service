import { useId, useState } from 'react';
import { Link2, Pencil, Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SetupStepActions, SetupStepHeader } from '@/components/setup/wizard/SetupStepParts';
import { ChainForm } from '@/components/x402/ChainForm';
import { RadioCardGroup } from '@/components/x402/setup/RadioCardGroup';
import type { X402Network } from '@/lib/api/generated';
import type { NetworkType } from '@/lib/contexts/AppContext';
import { X402_ACCENT } from '@/lib/x402-rail';
import { assetPresetsForNetwork } from '@/lib/x402-registration';
import { getX402ChainSetupStatus, type X402ChainSetupStatus } from '@/lib/x402-setup';

const STATUS_BADGE: Record<
  X402ChainSetupStatus,
  { label: string; variant: 'success' | 'warning' | 'secondary' }
> = {
  ready: { label: 'Receiving', variant: 'success' },
  'needs-facilitator': { label: 'Needs a facilitator', variant: 'warning' },
  disabled: { label: 'Disabled', variant: 'secondary' },
};

/** Symbol of the token the chain settles in, when it is a known preset. */
function settlementTokenSymbol(chain: X402Network): string | null {
  const presets = assetPresetsForNetwork(chain);
  if (!chain.defaultAsset) return presets[0]?.symbol ?? null;
  const configured = chain.defaultAsset.toLowerCase();
  return presets.find((preset) => preset.address.toLowerCase() === configured)?.symbol ?? null;
}

type ChainEditor = { kind: 'new' } | { kind: 'edit'; chain: X402Network } | null;

/**
 * Step 1: pick the chain payments and wallets live on. Chains of the active environment are
 * listed as a single-choice group with their setup status; a custom chain or a chain edit
 * opens inline, and a saved chain is selected straight away.
 */
export function X402ChainStep({
  networkType,
  chains,
  selectedChain,
  isAddSourceMode,
  onSelectChain,
  onChainSaved,
  onBack,
  onContinue,
}: {
  networkType: NetworkType;
  chains: X402Network[];
  selectedChain: X402Network | null;
  isAddSourceMode: boolean;
  onSelectChain: (chain: X402Network) => void;
  onChainSaved: (chain: X402Network) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  // With no chain in this environment the only useful thing is adding one, so open the form.
  const [editor, setEditor] = useState<ChainEditor>(chains.length === 0 ? { kind: 'new' } : null);
  const groupLabelId = useId();
  const isSelectedReady = selectedChain
    ? getX402ChainSetupStatus(selectedChain) === 'ready'
    : false;

  const chainForm = editor && (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <p className="text-sm font-medium">
        {editor.kind === 'new' ? 'Add a custom EVM chain' : `Edit ${editor.chain.displayName}`}
      </p>
      <p className="mb-4 text-pretty text-xs text-muted-foreground">
        {editor.kind === 'new'
          ? `The chain is added to ${networkType}. You set up receiving in the next step.`
          : 'Change the RPC endpoint or default token. Receiving is set up in the next step.'}
      </p>
      <ChainForm
        key={editor.kind === 'new' ? 'new' : editor.chain.id}
        editing={editor.kind === 'edit' ? editor.chain : null}
        lockEnvironment
        includeFacilitator={false}
        variant="inline"
        onClose={() => setEditor(null)}
        onSaved={(chain) => {
          setEditor(null);
          onChainSaved(chain);
        }}
      />
    </div>
  );

  return (
    <div className="mx-auto w-full max-w-lg space-y-6">
      <SetupStepHeader
        icon={Link2}
        iconClassName={X402_ACCENT.icon}
        iconRingClassName={X402_ACCENT.iconRing}
        title={isAddSourceMode ? 'Add an EVM payment source' : 'Choose a chain'}
        description="Payments and wallets stay on the chain you pick. You can add more chains later."
      />

      {chains.length > 0 && (
        <div className="space-y-2">
          <p id={groupLabelId} className="text-sm font-medium">
            {networkType} chains
          </p>
          <RadioCardGroup
            labelledBy={groupLabelId}
            value={selectedChain?.id ?? null}
            onChange={(chainId) => {
              const chain = chains.find((candidate) => candidate.id === chainId);
              if (chain) onSelectChain(chain);
            }}
            options={chains.map((chain) => {
              const status = STATUS_BADGE[getX402ChainSetupStatus(chain)];
              const token = settlementTokenSymbol(chain);
              return {
                value: chain.id,
                title: chain.displayName,
                description: (
                  <span className="font-mono">
                    {chain.caip2Id}
                    {token ? ` · settles in ${token}` : ''}
                  </span>
                ),
                aside: <Badge variant={status.variant}>{status.label}</Badge>,
              };
            })}
          />
        </div>
      )}

      {editor ? (
        chainForm
      ) : (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {selectedChain && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="gap-2 text-muted-foreground"
              onClick={() => setEditor({ kind: 'edit', chain: selectedChain })}
            >
              <Pencil className="size-3.5" aria-hidden />
              Edit {selectedChain.displayName}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-2 text-muted-foreground"
            onClick={() => setEditor({ kind: 'new' })}
          >
            <Plus className="size-3.5" aria-hidden />
            Add a custom EVM chain
          </Button>
        </div>
      )}

      <SetupStepActions
        backLabel={isAddSourceMode ? 'Cancel' : 'Back'}
        onBack={onBack}
        primaryLabel={isAddSourceMode && isSelectedReady ? 'Use this chain' : 'Continue'}
        onPrimary={onContinue}
        isPrimaryDisabled={!selectedChain || !!editor}
        blockedReason={
          editor ? 'Save or cancel the chain form to continue.' : 'Select a chain to continue.'
        }
      />
    </div>
  );
}
