import type { Payment, PostPurchaseData } from '@/lib/api/generated';
import type { NetworkType } from '@/lib/contexts/AppContext';
import { check, type ValidationCheck } from './checks';

/**
 * Builds the POST /purchase body for a payment an agent created on this node. The mapping is the one
 * MockPurchaseDialog uses: the seller signs several fields into the blockchain identifier, and the purchase
 * must send them back exactly or the identifier's signature check fails.
 */

export type PurchaseBody = NonNullable<PostPurchaseData['body']>;

export type PurchaseContext = {
  network: NetworkType;
  /** The nonce sent in start_job; the payment must have been created for it. */
  identifierFromPurchaser: string;
  /** The Cardano payment source index of the agent's pricing, or null for a V1 payment. */
  supportedPaymentSourceIndex: number | null;
  buyerReturnAddress?: string | null;
};

export type BuildPurchaseResult =
  | { ok: true; body: PurchaseBody }
  | { ok: false; problems: string[] };

export function newIdentifierFromPurchaser(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

type PaymentSourceIndexChoice = { ok: true; index: number | null } | { ok: false; problem: string };

/**
 * Which `supportedPaymentSourceIndex` the purchase must carry. V1 payments have none. On V2 it is the index the
 * agent returned from /start_job, else the index of the agent's only paid option. With several paid options, or
 * none we can match, any pick would be a guess and could lock funds against the wrong price, so we stop instead.
 */
export function choosePaymentSourceIndex(input: {
  isV2: boolean;
  startedIndex: number | null;
  /** The `supportedPaymentSourceIndex` of every paid option of the paying agent (undefined: the option has none). */
  candidateIndexes: Array<number | undefined>;
}): PaymentSourceIndexChoice {
  if (!input.isV2) return { ok: true, index: null };
  if (input.startedIndex != null) return { ok: true, index: input.startedIndex };
  const [only] = input.candidateIndexes;
  if (input.candidateIndexes.length === 1 && only != null) return { ok: true, index: only };
  const found =
    input.candidateIndexes.length === 0
      ? 'The agent was not found among your paid agents on this payment source.'
      : `The agent has ${input.candidateIndexes.length} paid options.`;
  return {
    ok: false,
    problem: `${found} /start_job did not say which payment source it priced.`,
  };
}

export function buildPurchaseBody(payment: Payment, context: PurchaseContext): BuildPurchaseResult {
  const sellerVkey = payment.SmartContractWallet?.walletVkey;
  const problems = [
    payment.agentIdentifier == null && 'The payment has no agentIdentifier.',
    payment.inputHash == null && 'The payment has no inputHash.',
    payment.payByTime == null && 'The payment has no payByTime.',
    !sellerVkey && 'The payment has no seller wallet, so the seller key is unknown.',
  ].filter((problem): problem is string => typeof problem === 'string');
  if (
    problems.length > 0 ||
    payment.agentIdentifier == null ||
    payment.inputHash == null ||
    payment.payByTime == null ||
    !sellerVkey
  ) {
    return { ok: false, problems };
  }

  const body: PurchaseBody = {
    blockchainIdentifier: payment.blockchainIdentifier,
    network: context.network,
    inputHash: payment.inputHash,
    sellerVkey,
    agentIdentifier: payment.agentIdentifier,
    identifierFromPurchaser: context.identifierFromPurchaser,
    payByTime: payment.payByTime,
    submitResultTime: payment.submitResultTime,
    unlockTime: payment.unlockTime,
    externalDisputeUnlockTime: payment.externalDisputeUnlockTime,
    ...(payment.RequestedFunds.length > 0
      ? { Amounts: payment.RequestedFunds.map(({ amount, unit }) => ({ amount, unit })) }
      : {}),
    ...(payment.forceLayer != null ? { paymentForceLayer: payment.forceLayer } : {}),
    ...(payment.sellerReturnAddress != null
      ? { sellerReturnAddress: payment.sellerReturnAddress }
      : {}),
    ...(context.supportedPaymentSourceIndex != null
      ? { supportedPaymentSourceIndex: context.supportedPaymentSourceIndex }
      : {}),
    ...(context.buyerReturnAddress ? { buyerReturnAddress: context.buyerReturnAddress } : {}),
  };
  return { ok: true, body };
}

type PurchaseFailureRule = { id: string; label: string; pattern: RegExp; fix: string };

// Ordered: the first matching rule wins. The patterns follow the messages of POST /purchase
// (routes/api/purchases/shared.ts and the time checks in purchases/index.ts).
const PURCHASE_FAILURE_RULES: PurchaseFailureRule[] = [
  {
    id: 'purchase.failed.signature',
    label: 'The payment terms match what the seller signed',
    pattern: /signature invalid|key does not match|key not found|format invalid/i,
    fix: 'The purchase did not reproduce the terms your agent signed. Make sure the agent creates its payment on this same node (its PAYMENT_SERVICE_URL), and that it returns the blockchainIdentifier unchanged.',
  },
  {
    id: 'purchase.failed.contract',
    label: "The payment uses this node's smart contract",
    pattern: /smartContractAddress|settlement does not match|payment source/i,
    fix: "The payment was created for a different smart contract or payment source than this node uses. Point your agent at this node, and register the agent with this node's payment source.",
  },
  {
    id: 'purchase.failed.times',
    label: 'The payment times are acceptable',
    pattern: /pay by time|submit result time|external dispute unlock time/i,
    fix: 'Create the payment with payByTime at least 5 minutes before submitResultTime, submitResultTime at least 15 minutes before unlockTime and 15 minutes ahead of now, and externalDisputeUnlockTime at least 15 minutes after unlockTime.',
  },
  {
    id: 'purchase.failed.funds',
    label: 'The purchasing wallet can pay',
    pattern: /insufficient|not enough|balance/i,
    fix: 'Top up the purchasing wallet (see "Node ready"), including the token the agent is priced in, then try again.',
  },
  {
    id: 'purchase.failed.agent',
    label: "The node can read the agent's registry entry",
    pattern: /agent identifier|agent metadata/i,
    fix: 'The node could not find or read the agent on-chain. Check that the agent is registered and confirmed, and that its metadata is valid (see the registry status check).',
  },
];

/** Turns the error of a rejected POST /purchase into a finding with the next step. */
export function purchaseFailureCheck(message: string): ValidationCheck {
  const rule = PURCHASE_FAILURE_RULES.find((entry) => entry.pattern.test(message));
  if (rule) return check('fail', rule.id, rule.label, { detail: message, fix: rule.fix });
  return check('fail', 'purchase.failed.unknown', 'The purchase was accepted', {
    detail: message,
    fix: 'Read the error above and fix its cause. The mock purchase uses the same endpoint as a real buyer.',
  });
}

const LOVELACE_PER_ADA = 1_000_000;

function shortUnit(unit: string): string {
  return unit.length <= 16 ? unit : `${unit.slice(0, 8)}…${unit.slice(-6)}`;
}

/** What a payment asks the buyer to lock, for the confirmation shown before a mock purchase spends anything. */
export function describeFunds(funds: readonly { amount: string; unit: string }[]): string {
  if (funds.length === 0) return 'nothing (a free agent)';
  return funds
    .map(({ amount, unit }) =>
      unit === ''
        ? `${Number((Number(amount) / LOVELACE_PER_ADA).toFixed(6))} ADA`
        : `${amount} of ${shortUnit(unit)}`,
    )
    .join(' + ');
}

/** A millisecond Unix timestamp (as the API sends it) as an ISO time; anything unparsable is shown unchanged. */
export function describeUnixMs(value: string): string {
  const time = Number(value);
  if (value.trim() === '' || !Number.isFinite(time)) return value;
  return new Date(time).toISOString();
}
