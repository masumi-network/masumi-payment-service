import type { X402Network, X402Wallet } from '@/lib/api/generated';

export type X402OptionDraft = {
  id: string;
  pricingType: 'Fixed' | 'Dynamic' | 'Free';
  caip2Network: string;
  asset: string;
  /** Human-readable token amount. Converted to atomic units on submit. */
  amount: string;
  decimals: string;
  payTo: string;
  resource: string;
};

export type EvmAssetPreset = {
  network: string;
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  isNative?: boolean;
};

export const EVM_ASSET_PRESETS: EvmAssetPreset[] = [
  {
    network: 'eip155:1',
    symbol: 'USDC',
    name: 'USD Coin',
    address: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    decimals: 6,
  },
  {
    network: 'eip155:11155111',
    symbol: 'USDC',
    name: 'USD Coin',
    address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    decimals: 6,
  },
  {
    network: 'eip155:8453',
    symbol: 'USDC',
    name: 'USD Coin',
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    decimals: 6,
  },
  {
    network: 'eip155:84532',
    symbol: 'USDC',
    name: 'USD Coin',
    address: '0x036CbD53842c5426634e7929541eC2318f3dCF7c',
    decimals: 6,
  },
];

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const NATIVE_ASSET = 'native';
const CAIP2_EIP155 = /^eip155:\d+$/;
const DECIMAL_AMOUNT = /^\d+(?:\.\d+)?$/;

const NATIVE_ASSET_BY_CHAIN_ID: Record<string, Pick<EvmAssetPreset, 'symbol' | 'name'>> = {
  '1': { symbol: 'ETH', name: 'Ether' },
  '10': { symbol: 'ETH', name: 'Ether' },
  '56': { symbol: 'BNB', name: 'BNB' },
  '100': { symbol: 'xDAI', name: 'xDAI' },
  '137': { symbol: 'POL', name: 'POL' },
  '8453': { symbol: 'ETH', name: 'Ether' },
  '42161': { symbol: 'ETH', name: 'Ether' },
  '43114': { symbol: 'AVAX', name: 'Avalanche' },
  '84532': { symbol: 'ETH', name: 'Ether' },
  '11155111': { symbol: 'ETH', name: 'Ether' },
};

export function newX402OptionId(): string {
  return crypto.randomUUID();
}

export function addressesMatch(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function nativeAssetForNetwork(
  network: X402Network | undefined,
): EvmAssetPreset | undefined {
  if (!network) return undefined;
  const chainId = network.caip2Id.split(':')[1] ?? '';
  const nativeAsset = NATIVE_ASSET_BY_CHAIN_ID[chainId] ?? {
    symbol: 'Native',
    name: `${network.displayName} native currency`,
  };
  return {
    network: network.caip2Id,
    ...nativeAsset,
    address: NATIVE_ASSET,
    decimals: 18,
    isNative: true,
  };
}

export function assetPresetsForNetwork(network: X402Network | undefined): EvmAssetPreset[] {
  if (!network) return [];

  const presets = EVM_ASSET_PRESETS.filter((preset) => preset.network === network.caip2Id);
  if (
    network.defaultAsset &&
    !presets.some((preset) => addressesMatch(preset.address, network.defaultAsset ?? ''))
  ) {
    presets.unshift({
      network: network.caip2Id,
      symbol: 'Default token',
      name: `${network.displayName} default token`,
      address: network.defaultAsset,
      decimals: 6,
    });
  }
  const nativeAsset = nativeAssetForNetwork(network);
  if (nativeAsset) presets.unshift(nativeAsset);
  return presets;
}

export function findAssetPreset(
  network: X402Network | undefined,
  asset: string,
): EvmAssetPreset | undefined {
  return assetPresetsForNetwork(network).find((preset) => addressesMatch(preset.address, asset));
}

export function defaultAssetForNetwork(
  network: X402Network | undefined,
): EvmAssetPreset | undefined {
  if (!network) return undefined;
  const presets = assetPresetsForNetwork(network);
  return (
    presets.find(
      (preset) => !!network.defaultAsset && addressesMatch(preset.address, network.defaultAsset),
    ) ??
    presets.find((preset) => !preset.isNative) ??
    presets[0]
  );
}

export function defaultX402Option(
  networks: X402Network[],
  wallets: X402Wallet[],
  preferredNetworkId?: string | null,
): X402OptionDraft {
  const network =
    networks.find((candidate) => candidate.id === preferredNetworkId && candidate.isEnabled) ??
    networks.find((candidate) => candidate.isEnabled && candidate.defaultAsset) ??
    networks.find((candidate) => candidate.isEnabled) ??
    networks[0];
  const wallet = wallets.find(
    (candidate) => candidate.type === 'Selling' && candidate.networkId === network?.id,
  );

  return {
    id: newX402OptionId(),
    pricingType: 'Dynamic',
    caip2Network: network?.caip2Id ?? '',
    asset: '',
    amount: '',
    decimals: '',
    payTo: wallet?.address ?? '',
    resource: '',
  };
}

/** Convert a display amount to the unsigned integer string expected by x402. */
export function normalizeX402Amount(amount: string, decimalsInput: string): string {
  const decimals = Number(decimalsInput);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) return amount;
  if (!DECIMAL_AMOUNT.test(amount)) return amount;

  const [whole, fraction = ''] = amount.split('.');
  if (fraction.length > decimals) return amount;
  const atomic = `${whole}${fraction.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/, '');
  return BigInt(atomic || '0').toString();
}

/** Convert an API base-unit amount into the value operators edit in the form. */
export function x402AmountFromBaseUnits(amount: string, decimals: number): string {
  if (!/^\d+$/.test(amount) || !Number.isInteger(decimals) || decimals < 0) return amount;
  if (decimals === 0) return BigInt(amount).toString();

  const padded = amount.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals).replace(/^0+(?=\d)/, '') || '0';
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

export function validateX402Options(options: X402OptionDraft[]): string | null {
  for (let index = 0; index < options.length; index++) {
    const option = options[index];
    const optionNumber = index + 1;
    if (!CAIP2_EIP155.test(option.caip2Network)) {
      return `x402 option ${optionNumber}: select a chain`;
    }
    if (option.pricingType !== 'Free') {
      const hasAsset = option.asset.length > 0;
      if (option.pricingType === 'Fixed' && !hasAsset) {
        return `x402 option ${optionNumber}: select a coin or enter a token contract`;
      }
      if (hasAsset && option.asset !== NATIVE_ASSET && !EVM_ADDRESS.test(option.asset)) {
        return `x402 option ${optionNumber}: select a coin or enter a token contract`;
      }
      if (hasAsset) {
        const decimals = Number(option.decimals);
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
          return `x402 option ${optionNumber}: decimals must be a whole number between 0 and 255`;
        }
      }
      if (option.pricingType === 'Fixed') {
        const decimals = Number(option.decimals);
        const fractionalDigits = option.amount.split('.')[1]?.length ?? 0;
        if (fractionalDigits > decimals) {
          return `x402 option ${optionNumber}: amount supports at most ${decimals} decimal places`;
        }
        const normalizedAmount = normalizeX402Amount(option.amount, option.decimals);
        if (
          !DECIMAL_AMOUNT.test(option.amount) ||
          !/^\d+$/.test(normalizedAmount) ||
          BigInt(normalizedAmount) <= BigInt(0)
        ) {
          return `x402 option ${optionNumber}: enter an amount greater than zero`;
        }
      }
    }
    if (!EVM_ADDRESS.test(option.payTo)) {
      return `x402 option ${optionNumber}: select a wallet or enter an EVM address`;
    }
    if (option.resource && !/^https?:\/\//.test(option.resource)) {
      return `x402 option ${optionNumber}: resource must be an http(s) URL`;
    }
  }
  return null;
}
