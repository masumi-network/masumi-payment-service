import type { X402AvailableNetwork, X402Wallet } from '@/lib/api/generated';
import { POSTGRES_BIGINT_MAX } from '@/lib/registry-validation';

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
  /**
   * Index of the stored source in `supportedPaymentSources` this draft was
   * prefilled from (update mode). Undefined for newly added options; used on
   * submit to preserve the stored on-chain ordering.
   */
  originalIndex?: number;
};

export type EvmAssetPreset = {
  network: string;
  symbol: string;
  name: string;
  address: string;
  decimals: number;
};

export type X402RegistrationNetwork = X402AvailableNetwork;

// Known USDC deployments per chain. These addresses are also seeded as network
// defaults by prisma/migrations/20260720010000_x402_network_default_asset_decimals;
// keep the two lists in sync when adding a chain. A network's configured
// defaultAsset/defaultAssetDecimals always takes precedence (see
// assetPresetsForNetwork below), so drift here only affects the preset labels.
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
const CAIP2_EIP155 = /^eip155:\d+$/;
const DECIMAL_AMOUNT = /^\d+(?:\.\d+)?$/;
// Mirrors the backend's `resource: z.string().url().max(500)` in
// packages/payment-core/src/payment-source.ts.
export const X402_RESOURCE_MAX_LENGTH = 500;

export function newX402OptionId(): string {
  return crypto.randomUUID();
}

export function addressesMatch(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function assetPresetsForNetwork(
  network: X402RegistrationNetwork | undefined,
): EvmAssetPreset[] {
  if (!network) return [];

  const presets = EVM_ASSET_PRESETS.filter((preset) => preset.network === network.caip2Id);
  if (network.defaultAsset && network.defaultAssetDecimals != null) {
    const configuredPresetIndex = presets.findIndex((preset) =>
      addressesMatch(preset.address, network.defaultAsset ?? ''),
    );
    if (configuredPresetIndex >= 0) {
      const preset = presets[configuredPresetIndex];
      if (preset) {
        presets[configuredPresetIndex] = {
          ...preset,
          address: network.defaultAsset,
          decimals: network.defaultAssetDecimals,
        };
      }
    } else {
      presets.unshift({
        network: network.caip2Id,
        symbol: 'Default token',
        name: `${network.displayName} default token`,
        address: network.defaultAsset,
        decimals: network.defaultAssetDecimals,
      });
    }
  }
  return presets;
}

export function findAssetPreset(
  network: X402RegistrationNetwork | undefined,
  asset: string,
): EvmAssetPreset | undefined {
  return assetPresetsForNetwork(network).find((preset) => addressesMatch(preset.address, asset));
}

export function defaultAssetForNetwork(
  network: X402RegistrationNetwork | undefined,
): EvmAssetPreset | undefined {
  if (!network) return undefined;
  const presets = assetPresetsForNetwork(network);
  return (
    presets.find(
      (preset) => !!network.defaultAsset && addressesMatch(preset.address, network.defaultAsset),
    ) ?? presets[0]
  );
}

export function defaultX402Option(
  networks: X402RegistrationNetwork[],
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

export type X402OptionValidationError = {
  index: number;
  message: string;
};

function duplicateKey(option: X402OptionDraft): string {
  const asset = option.pricingType === 'Free' ? '' : option.asset.toLowerCase();
  const amount =
    option.pricingType === 'Fixed' ? normalizeX402Amount(option.amount, option.decimals) : '';
  const decimals =
    option.pricingType === 'Free' || !asset
      ? ''
      : Number.isInteger(Number(option.decimals))
        ? Number(option.decimals).toString()
        : option.decimals;

  return JSON.stringify([
    option.caip2Network,
    option.pricingType,
    asset,
    amount,
    decimals,
    option.payTo.toLowerCase(),
    option.resource,
  ]);
}

function isParseableUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a list of x402 option drafts.
 *
 * `labels` optionally maps each option index to the user-facing name the
 * surrounding UI shows for it (e.g. "Payment option 3" when the dialog
 * interleaves Masumi and x402 rows) so error messages match the numbering the
 * operator actually sees. Missing entries fall back to `x402 option N`
 * numbered within this list.
 */
export function findX402ValidationError(
  options: X402OptionDraft[],
  labels?: ReadonlyArray<string | undefined>,
): X402OptionValidationError | null {
  const firstIndexByKey = new Map<string, number>();
  const labelFor = (index: number) => labels?.[index] ?? `x402 option ${index + 1}`;

  for (let index = 0; index < options.length; index++) {
    const option = options[index];
    if (!CAIP2_EIP155.test(option.caip2Network)) {
      return { index, message: `${labelFor(index)}: select a chain` };
    }
    if (option.pricingType !== 'Free') {
      const hasAsset = option.asset.length > 0;
      if (option.pricingType === 'Fixed' && !hasAsset) {
        return {
          index,
          message: `${labelFor(index)}: select a coin or enter a token contract`,
        };
      }
      if (hasAsset && !EVM_ADDRESS.test(option.asset)) {
        return {
          index,
          message: `${labelFor(index)}: select a coin or enter a token contract`,
        };
      }
      if (hasAsset) {
        // Digits-only, not Number(): Number('') is 0, which would silently
        // submit a blank decimals field as 0 for a custom token.
        if (!/^\d{1,3}$/.test(option.decimals.trim()) || Number(option.decimals) > 255) {
          return {
            index,
            message: `${labelFor(index)}: decimals must be a whole number between 0 and 255`,
          };
        }
      }
      if (option.pricingType === 'Fixed') {
        const decimals = Number(option.decimals);
        const fractionalDigits = option.amount.split('.')[1]?.length ?? 0;
        if (fractionalDigits > decimals) {
          return {
            index,
            message: `${labelFor(index)}: amount supports at most ${decimals} decimal places`,
          };
        }
        const normalizedAmount = normalizeX402Amount(option.amount, option.decimals);
        if (
          !DECIMAL_AMOUNT.test(option.amount) ||
          !/^\d+$/.test(normalizedAmount) ||
          BigInt(normalizedAmount) <= BigInt(0) ||
          BigInt(normalizedAmount) > POSTGRES_BIGINT_MAX
        ) {
          return {
            index,
            message:
              `${labelFor(index)}: enter an amount between 1 and ` +
              `${POSTGRES_BIGINT_MAX.toString()} atomic units`,
          };
        }
      }
    }
    if (!EVM_ADDRESS.test(option.payTo)) {
      return {
        index,
        message: `${labelFor(index)}: select a wallet or enter an EVM address`,
      };
    }
    if (option.resource) {
      // Mirror the backend contract (`z.string().url().max(500)`): a real URL
      // parse plus the length cap, on top of the http(s) scheme requirement.
      if (option.resource.length > X402_RESOURCE_MAX_LENGTH) {
        return {
          index,
          message: `${labelFor(index)}: resource URL must be at most ${X402_RESOURCE_MAX_LENGTH} characters`,
        };
      }
      if (!/^https?:\/\//.test(option.resource) || !isParseableUrl(option.resource)) {
        return {
          index,
          message: `${labelFor(index)}: resource must be an http(s) URL`,
        };
      }
    }

    const key = duplicateKey(option);
    const duplicateOf = firstIndexByKey.get(key);
    if (duplicateOf != null) {
      const duplicateLabel =
        labels?.[duplicateOf] != null ? labels[duplicateOf] : `option ${duplicateOf + 1}`;
      return {
        index,
        message:
          `${labelFor(index)}: duplicates ${duplicateLabel}. ` +
          'Change its chain, pricing, coin, recipient, or resource.',
      };
    }
    firstIndexByKey.set(key, index);
  }
  return null;
}

export function validateX402Options(options: X402OptionDraft[]): string | null {
  return findX402ValidationError(options)?.message ?? null;
}
