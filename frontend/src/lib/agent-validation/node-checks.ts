import type { NetworkType } from '@/lib/contexts/AppContext';
import type { RailReadinessRail } from '@/lib/rail-readiness';
import type { HotWalletType } from '@/lib/wallet-type';
import { MIN_MINT_BALANCE_LOVELACE } from '../agent-mint';
import { check, type ValidationCheck } from './checks';

/**
 * "Is this node ready to host an agent?": the backend's readiness checks, plus the funding checks the
 * backend does not make (it only checks that wallets exist, never what they hold).
 */

const LOVELACE_PER_ADA = 1_000_000;
/** The V2 collateral reserve a wallet must keep (backend COLLATERAL_RESERVE_LOVELACE, 5 ADA). */
export const COLLATERAL_RESERVE_LOVELACE = 5 * LOVELACE_PER_ADA;
/** Registering mints an NFT (the 3 ADA the register dialog requires) and keeps the collateral reserve. */
export const SELLING_WALLET_MIN_LOVELACE = MIN_MINT_BALANCE_LOVELACE + COLLATERAL_RESERVE_LOVELACE;
/** Fees plus the minimum ADA that travels with the funds a purchase locks. */
export const PURCHASING_WALLET_MIN_LOVELACE = 5 * LOVELACE_PER_ADA;

const PREPROD_FAUCET_URL = 'https://docs.cardano.org/cardano-testnets/tools/faucet';
const MASUMI_DISPENSER_URL = 'https://dispenser.masumi.network/';
const TOP_UP_DOCS_URL =
  'https://www.masumi.network/dev/masumi/documentation/how-to-guides/top-up-your-wallets';

export type NodeWallet = {
  id: string;
  type: HotWalletType;
  walletAddress: string;
  /** Lovelace, or null when the balance could not be read. */
  balanceLovelace: number | null;
  /** The network's stablecoin (tUSDM on Preprod), or null when it could not be read. */
  stablecoinBalance: number | null;
};

export type NodeCheckInput = {
  network: NetworkType;
  rail: RailReadinessRail | null;
  /** The readiness request failed. Readiness is then unknown, which is not the same as "not ready". */
  isReadinessUnavailable: boolean;
  walletsLoaded: boolean;
  wallets: NodeWallet[];
};

const READINESS_FIXES: Record<string, string> = {
  'cardano.payment_source': 'Create a payment source in Setup.',
  'cardano.contract_current':
    'This payment source uses a retired contract. Create a new payment source for the current contract in Setup.',
  'cardano.rpc_provider': 'Add a Blockfrost API key to the payment source (Payment Sources).',
  'cardano.admin_signatures': 'Add the admin wallets to the payment source (Payment Sources).',
  'cardano.selling_wallet': 'Add a selling wallet in Wallets.',
  'cardano.purchasing_wallet':
    'Add a purchasing wallet in Wallets. It pays for the mock purchase of your own agent.',
  'cardano.payments_enabled': 'Enable payments on the payment source (Payment Sources).',
};
const GENERIC_READINESS_FIX = 'Open Setup and complete this step.';

export function formatAda(lovelace: number): string {
  return `${Number((lovelace / LOVELACE_PER_ADA).toFixed(2))} ADA`;
}

export function shortAddress(address: string): string {
  return address.length <= 20 ? address : `${address.slice(0, 12)}…${address.slice(-6)}`;
}

export function buildNodeChecks(input: NodeCheckInput): ValidationCheck[] {
  return [
    ...readinessChecks(input),
    ...fundingCheck(input, 'Selling', 'selling_wallet', SELLING_WALLET_MIN_LOVELACE, {
      what: 'register an agent',
      breakdown: '3 ADA to mint plus a 5 ADA collateral reserve',
    }),
    ...fundingCheck(input, 'Purchasing', 'purchasing_wallet', PURCHASING_WALLET_MIN_LOVELACE, {
      what: 'buy your own agent in the mock purchase',
      breakdown: 'fees plus the minimum ADA that travels with locked funds',
    }),
    ...stablecoinCheck(input),
    ...(input.network === 'Mainnet'
      ? [
          check('warn', 'node.network.mainnet', 'Network is Preprod', {
            detail:
              'You are on Mainnet. A purchase moves real funds, so the mock purchase is only available on Preprod.',
            fix: 'Switch the network to Preprod to run the full flow.',
          }),
        ]
      : []),
  ];
}

function readinessChecks({ rail, isReadinessUnavailable }: NodeCheckInput): ValidationCheck[] {
  if (isReadinessUnavailable) {
    return [
      check('warn', 'node.readiness.unavailable', 'Node readiness could be read', {
        detail: 'The readiness request failed, so it is unknown whether the node is set up.',
        fix: 'Check that the payment service is reachable, then run the checks again.',
      }),
    ];
  }
  return (rail?.Checks ?? []).map((entry) =>
    check(entry.isComplete ? 'pass' : 'fail', `node.${entry.id}`, entry.label, {
      detail: entry.detail,
      fix: entry.isComplete ? null : (READINESS_FIXES[entry.id] ?? GENERIC_READINESS_FIX),
    }),
  );
}

function bestWallet(wallets: NodeWallet[], type: HotWalletType): NodeWallet | undefined {
  return wallets
    .filter((entry) => entry.type === type)
    .reduce<
      NodeWallet | undefined
    >((best, entry) => (best == null || (entry.balanceLovelace ?? -1) > (best.balanceLovelace ?? -1) ? entry : best), undefined);
}

function topUpFix(network: NetworkType, address: string, missingLovelace: number): string {
  const send = `Send at least ${formatAda(missingLovelace)} more to ${address}`;
  return network === 'Preprod'
    ? `${send} from the Cardano Preprod faucet (${PREPROD_FAUCET_URL}) or Masumi's dispenser (${MASUMI_DISPENSER_URL}).`
    : `${send}.`;
}

function fundingCheck(
  input: NodeCheckInput,
  type: HotWalletType,
  idPart: string,
  minLovelace: number,
  text: { what: string; breakdown: string },
): ValidationCheck[] {
  const id = `node.${idPart}.funded`;
  const label = `${type} wallet holds enough ADA`;
  if (!input.walletsLoaded) return [check('skipped', id, label)];

  const wallet = bestWallet(input.wallets, type);
  if (wallet == null) {
    return [
      check('fail', id, label, {
        detail: `There is no ${type.toLowerCase()} wallet on this node.`,
        fix: `Add a ${type.toLowerCase()} wallet in Wallets, then fund it.`,
        docsUrl: TOP_UP_DOCS_URL,
      }),
    ];
  }
  if (wallet.balanceLovelace == null) {
    return [
      check('warn', id, label, {
        detail: `The balance of ${shortAddress(wallet.walletAddress)} could not be read.`,
        fix: 'Check the Blockfrost API key of the payment source, then run the checks again.',
        docsUrl: TOP_UP_DOCS_URL,
      }),
    ];
  }
  if (wallet.balanceLovelace >= minLovelace) {
    return [
      check('pass', id, label, {
        detail: `${formatAda(wallet.balanceLovelace)} in ${shortAddress(wallet.walletAddress)}.`,
      }),
    ];
  }
  return [
    check('fail', id, label, {
      detail: `The best ${type.toLowerCase()} wallet holds ${formatAda(wallet.balanceLovelace)}, and you need at least ${formatAda(minLovelace)} to ${text.what} (${text.breakdown}).`,
      fix: topUpFix(input.network, wallet.walletAddress, minLovelace - wallet.balanceLovelace),
      docsUrl: TOP_UP_DOCS_URL,
    }),
  ];
}

function stablecoinCheck(input: NodeCheckInput): ValidationCheck[] {
  const wallet = bestWallet(input.wallets, 'Purchasing');
  if (!input.walletsLoaded || wallet == null || wallet.stablecoinBalance == null) return [];
  const coin = input.network === 'Preprod' ? 'tUSDM' : 'USDCx';
  const id = 'node.purchasing_wallet.stablecoin';
  const label = `Purchasing wallet holds ${coin}`;
  return wallet.stablecoinBalance > 0
    ? [check('pass', id, label)]
    : [
        check('warn', id, label, {
          detail: `The purchasing wallet holds no ${coin}. Agents are normally priced in ${coin}, so the mock purchase of a priced agent will fail.`,
          fix:
            input.network === 'Preprod'
              ? `Send some tUSDM to ${wallet.walletAddress} with Masumi's dispenser (${MASUMI_DISPENSER_URL}).`
              : `Send some ${coin} to ${wallet.walletAddress}.`,
          docsUrl: TOP_UP_DOCS_URL,
        }),
      ];
}
