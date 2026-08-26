import type { ReactNode } from 'react';
import {
  ArrowRight,
  ChevronDown,
  ChevronsUpDown,
  Link2,
  Plus,
  type LucideIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { X402Network } from '@/lib/api/generated';
import type { NetworkType } from '@/lib/contexts/AppContext';
import { cn } from '@/lib/utils';
import { X402_ACCENT } from '@/lib/x402-rail';

const ADD_CUSTOM_CHAIN_VALUE = '__add_custom_chain__';

export function X402SetupStepHeaderIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <div className="relative mx-auto mb-5 h-14 w-14 animate-fade-in-up">
      <div className="absolute inset-0 rounded-2xl bg-indigo-500/20 blur-xl" />
      <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500/20 to-indigo-500/5 ring-1 ring-indigo-500/30">
        <Icon className={cn('h-7 w-7', X402_ACCENT.icon)} />
      </div>
    </div>
  );
}

export function X402ChainSelectionStep({
  networkType,
  chains,
  selectedChain,
  isAddSourceMode,
  isSelectedChainReady,
  isCreatingChain,
  isEditorOpen,
  chainEditor,
  onSelectChain,
  onAddCustom,
  onEditorOpenChange,
  onBack,
  onContinue,
}: {
  networkType: NetworkType;
  chains: X402Network[];
  selectedChain: X402Network | null;
  isAddSourceMode: boolean;
  isSelectedChainReady: boolean;
  isCreatingChain: boolean;
  isEditorOpen: boolean;
  chainEditor: ReactNode;
  onSelectChain: (chainId: string) => void;
  onAddCustom: () => void;
  onEditorOpenChange: (open: boolean) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const sourceSelect = (
    <Select
      value={isCreatingChain ? ADD_CUSTOM_CHAIN_VALUE : (selectedChain?.id ?? '')}
      onValueChange={(value) => {
        if (value === ADD_CUSTOM_CHAIN_VALUE) {
          onAddCustom();
          return;
        }
        onSelectChain(value);
      }}
    >
      <SelectTrigger
        aria-label="EVM payment source"
        className={cn(
          selectedChain &&
            !isCreatingChain &&
            'h-auto min-h-14 rounded-none border-0 shadow-none [&>svg]:hidden',
        )}
      >
        {selectedChain && !isCreatingChain ? (
          <div className="flex min-w-0 flex-1 items-center justify-between gap-3 pr-1 text-left">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{selectedChain.displayName}</p>
              <p className="truncate font-mono text-xs text-muted-foreground">
                {selectedChain.caip2Id}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge variant={selectedChain.isEnabled ? 'success' : 'secondary'}>
                {selectedChain.isEnabled ? 'Enabled' : 'Draft'}
              </Badge>
              <ChevronsUpDown className="h-4 w-4 text-muted-foreground" />
            </div>
          </div>
        ) : (
          <SelectValue placeholder="Select a chain" />
        )}
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {chains.map((chain) => (
            <SelectItem key={chain.id} value={chain.id}>
              {chain.displayName} · {chain.caip2Id}
            </SelectItem>
          ))}
          {chains.length > 0 && <SelectSeparator />}
          <SelectItem value={ADD_CUSTOM_CHAIN_VALUE}>
            <span className="flex items-center gap-2">
              <Plus className="h-4 w-4" />
              Add custom chain…
            </span>
          </SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );

  return (
    <div className="mx-auto w-full max-w-lg">
      <div className="text-center">
        <X402SetupStepHeaderIcon icon={Link2} />
        <h1 className="text-2xl font-bold tracking-tight">
          {isAddSourceMode ? 'Add an EVM payment source' : 'Choose your EVM chain'}
        </h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          Choose a configured chain or add a custom chain for {networkType}. Wallets and payments
          stay bound to the selected chain.
        </p>
      </div>

      <div className="mt-6 space-y-4 rounded-xl border bg-card p-5 text-card-foreground shadow-sm">
        <div className="space-y-2">
          <label className="text-sm font-medium">Payment source</label>
          {selectedChain && !isCreatingChain ? (
            <Collapsible open={isEditorOpen} onOpenChange={onEditorOpenChange}>
              <div className="overflow-hidden rounded-lg border bg-muted/20">
                <div className="flex items-stretch">
                  <div className="min-w-0 flex-1">{sourceSelect}</div>
                  <CollapsibleTrigger asChild>
                    <button
                      type="button"
                      aria-label={`Configure ${selectedChain.displayName}`}
                      className="group border-l px-3 hover:bg-muted/40"
                    >
                      <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
                    </button>
                  </CollapsibleTrigger>
                </div>
                <CollapsibleContent>
                  <div className="border-t p-4">{chainEditor}</div>
                </CollapsibleContent>
              </div>
            </Collapsible>
          ) : (
            sourceSelect
          )}
        </div>

        {isCreatingChain ? (
          <div className="border-t pt-4">
            <div className="mb-4">
              <p className="text-sm font-medium">Custom chain settings</p>
              <p className="text-xs text-muted-foreground">
                Add an EVM chain for this {networkType} environment.
              </p>
            </div>
            {chainEditor}
          </div>
        ) : !selectedChain ? (
          <div className="rounded-lg border border-dashed p-5 text-center">
            <p className="text-sm font-medium">No {networkType} EVM chain exists yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Select Add custom chain to create the first payment source.
            </p>
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-between pt-6">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button
          className="btn-hover-lift group gap-2"
          disabled={!selectedChain || isCreatingChain}
          onClick={onContinue}
        >
          {isAddSourceMode && isSelectedChainReady ? 'Use selected chain' : 'Continue'}{' '}
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
        </Button>
      </div>
    </div>
  );
}
