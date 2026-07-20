import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import type { X402AvailableNetwork, X402Wallet } from '@/lib/api/generated';
import { shortenAddress } from '@/lib/utils';
import {
  addressesMatch,
  assetPresetsForNetwork,
  defaultAssetForNetwork,
  findAssetPreset,
  type X402OptionDraft,
} from '@/lib/x402-registration';

const CUSTOM_ASSET = '__custom_asset__';
const ANY_ASSET = '__any_asset__';
const CUSTOM_WALLET = '__custom_wallet__';

export function X402OptionFields({
  option,
  optionNumber,
  networks,
  wallets,
  isLoadingWallets,
  onChange,
}: {
  option: X402OptionDraft;
  optionNumber: number;
  networks: X402AvailableNetwork[];
  wallets: X402Wallet[];
  isLoadingWallets: boolean;
  onChange: (patch: Partial<X402OptionDraft>) => void;
}) {
  const selectedNetwork = networks.find((network) => network.caip2Id === option.caip2Network);
  const assetPresets = assetPresetsForNetwork(selectedNetwork);
  const selectedAssetPreset = findAssetPreset(selectedNetwork, option.asset);
  const availableWallets = wallets.filter(
    (wallet) => wallet.type === 'Selling' && wallet.networkId === selectedNetwork?.id,
  );
  const selectedWallet = availableWallets.find((wallet) =>
    addressesMatch(wallet.address, option.payTo),
  );
  const isCustomWallet = !selectedWallet;
  const isCustomAsset = !!option.asset && !selectedAssetPreset;
  const hasKnownTokenDecimals = !!selectedAssetPreset;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium">Pricing model</label>
          <Select
            value={option.pricingType}
            onValueChange={(value: X402OptionDraft['pricingType']) => {
              if (value === 'Fixed') {
                const defaultAsset = defaultAssetForNetwork(selectedNetwork);
                onChange({
                  pricingType: value,
                  asset: defaultAsset?.address ?? selectedNetwork?.defaultAsset ?? '',
                  decimals: String(defaultAsset?.decimals ?? ''),
                  amount: '',
                });
                return;
              }
              onChange({
                pricingType: value,
                asset: '',
                decimals: '',
                amount: '',
              });
            }}
          >
            <SelectTrigger aria-label={`Pricing model for payment option ${optionNumber}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="Dynamic">Dynamic (default)</SelectItem>
                <SelectItem value="Fixed">Fixed</SelectItem>
                <SelectItem value="Free">Free</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium">Receive in</label>
          <Select
            value={selectedWallet?.id ?? CUSTOM_WALLET}
            onValueChange={(value) => {
              if (value === CUSTOM_WALLET) {
                onChange({ payTo: selectedWallet ? '' : option.payTo });
                return;
              }
              const wallet = availableWallets.find((candidate) => candidate.id === value);
              if (wallet) onChange({ payTo: wallet.address });
            }}
            disabled={isLoadingWallets}
          >
            <SelectTrigger aria-label={`Recipient for payment option ${optionNumber}`}>
              <SelectValue
                placeholder={isLoadingWallets ? 'Loading wallets...' : 'Select a wallet'}
              />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {availableWallets.map((wallet) => (
                  <SelectItem key={wallet.id} value={wallet.id}>
                    {wallet.note || 'Selling wallet'}
                    <span className="ml-2 font-mono text-xs text-muted-foreground">
                      {shortenAddress(wallet.address, 6)}
                    </span>
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM_WALLET}>Custom EVM address</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          {isCustomWallet ? (
            <Input
              aria-label={`Custom EVM recipient for payment option ${optionNumber}`}
              className="font-mono"
              placeholder="0x… recipient address"
              value={option.payTo}
              onChange={(event) => onChange({ payTo: event.target.value })}
            />
          ) : null}
        </div>
      </div>

      {option.pricingType === 'Fixed' ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label htmlFor={`x402-amount-${option.id}`} className="text-xs font-medium">
              Price
            </label>
            <Input
              id={`x402-amount-${option.id}`}
              type="text"
              inputMode="decimal"
              placeholder="1.00"
              value={option.amount}
              onChange={(event) => onChange({ amount: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium">Coin</label>
            <Select
              value={selectedAssetPreset?.address ?? CUSTOM_ASSET}
              onValueChange={(value) => {
                if (value === CUSTOM_ASSET) {
                  onChange({ asset: '0x', decimals: '' });
                  return;
                }
                const preset = assetPresets.find((candidate) => candidate.address === value);
                if (preset) {
                  onChange({
                    asset: preset.address,
                    decimals: String(preset.decimals),
                  });
                }
              }}
            >
              <SelectTrigger aria-label={`Coin for payment option ${optionNumber}`}>
                <SelectValue placeholder="Select a coin" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {assetPresets.map((preset) => (
                    <SelectItem key={preset.address} value={preset.address}>
                      {preset.symbol}
                      <span className="ml-2 text-xs text-muted-foreground">
                        {shortenAddress(preset.address, 5)}
                      </span>
                    </SelectItem>
                  ))}
                  <SelectItem value={CUSTOM_ASSET}>Custom token</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </div>
      ) : null}

      <Collapsible defaultOpen={isCustomAsset || !!option.resource}>
        <Separator />
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="group mt-2 w-full justify-between px-2 text-muted-foreground hover:text-foreground"
          >
            <span>Advanced settings</span>
            <span className="flex min-w-0 items-center gap-2">
              <span className="max-w-44 truncate font-normal">
                {selectedNetwork?.displayName ?? 'Select chain'}
              </span>
              <ChevronDown
                data-icon="inline-end"
                className="transition-transform duration-200 group-data-[state=open]:rotate-180"
              />
            </span>
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1 sm:col-span-2">
              <label className="text-xs font-medium">Chain override</label>
              <Select
                value={option.caip2Network}
                onValueChange={(value) => {
                  const network = networks.find((candidate) => candidate.caip2Id === value);
                  const asset = defaultAssetForNetwork(network);
                  const wallet = wallets.find(
                    (candidate) =>
                      candidate.type === 'Selling' && candidate.networkId === network?.id,
                  );
                  onChange({
                    caip2Network: value,
                    asset:
                      option.pricingType === 'Fixed'
                        ? (asset?.address ?? network?.defaultAsset ?? '')
                        : '',
                    decimals: option.pricingType === 'Fixed' ? String(asset?.decimals ?? '') : '',
                    payTo: wallet?.address ?? '',
                  });
                }}
              >
                <SelectTrigger aria-label={`Chain for payment option ${optionNumber}`}>
                  <SelectValue placeholder="Select a chain" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {networks.map((network) => (
                      <SelectItem key={network.id} value={network.caip2Id}>
                        {network.displayName}
                        <span className="ml-2 font-mono text-xs text-muted-foreground">
                          {network.caip2Id}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            {option.pricingType === 'Dynamic' ? (
              <div className="flex flex-col gap-1 sm:col-span-2">
                <label className="text-xs font-medium">Accepted coin (optional)</label>
                <Select
                  value={!option.asset ? ANY_ASSET : (selectedAssetPreset?.address ?? CUSTOM_ASSET)}
                  onValueChange={(value) => {
                    if (value === ANY_ASSET) {
                      onChange({ asset: '', decimals: '' });
                      return;
                    }
                    if (value === CUSTOM_ASSET) {
                      onChange({ asset: '0x', decimals: '' });
                      return;
                    }
                    const preset = assetPresets.find((candidate) => candidate.address === value);
                    if (preset) {
                      onChange({
                        asset: preset.address,
                        decimals: String(preset.decimals),
                      });
                    }
                  }}
                >
                  <SelectTrigger aria-label={`Coin for payment option ${optionNumber}`}>
                    <SelectValue placeholder="Select a coin" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value={ANY_ASSET}>Any supported asset</SelectItem>
                      {assetPresets.map((preset) => (
                        <SelectItem key={preset.address} value={preset.address}>
                          {preset.symbol}
                          <span className="ml-2 text-xs text-muted-foreground">
                            {shortenAddress(preset.address, 5)}
                          </span>
                        </SelectItem>
                      ))}
                      <SelectItem value={CUSTOM_ASSET}>Custom token</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {!option.asset ? (
                  <p className="text-xs text-muted-foreground">
                    The runtime 402 chooses the asset, decimals, and exact amount.
                  </p>
                ) : null}
              </div>
            ) : null}
            {option.pricingType !== 'Free' && isCustomAsset ? (
              <div className="flex flex-col gap-1">
                <label htmlFor={`x402-contract-${option.id}`} className="text-xs font-medium">
                  Token contract
                </label>
                <Input
                  id={`x402-contract-${option.id}`}
                  className="font-mono"
                  placeholder="0x… token contract"
                  value={option.asset}
                  onChange={(event) => onChange({ asset: event.target.value })}
                />
              </div>
            ) : option.pricingType !== 'Free' && option.asset ? (
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium">Token contract</span>
                <Input
                  aria-label={`Token contract for payment option ${optionNumber}`}
                  className="font-mono"
                  value={option.asset}
                  readOnly
                />
              </div>
            ) : null}
            {option.pricingType !== 'Free' && option.asset ? (
              <div className="flex flex-col gap-1">
                <label htmlFor={`x402-decimals-${option.id}`} className="text-xs font-medium">
                  Token decimals
                </label>
                <Input
                  id={`x402-decimals-${option.id}`}
                  type="number"
                  inputMode="numeric"
                  min="0"
                  max="255"
                  value={option.decimals}
                  readOnly={hasKnownTokenDecimals}
                  onChange={(event) => onChange({ decimals: event.target.value })}
                />
              </div>
            ) : null}
            <div className="flex flex-col gap-1 sm:col-span-2">
              <label htmlFor={`x402-resource-${option.id}`} className="text-xs font-medium">
                Protected resource URL
              </label>
              <Input
                id={`x402-resource-${option.id}`}
                type="url"
                placeholder="https://agent.example.com/resource"
                value={option.resource}
                onChange={(event) => onChange({ resource: event.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                Optional. Leave blank when this option applies to the agent API generally.
              </p>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
