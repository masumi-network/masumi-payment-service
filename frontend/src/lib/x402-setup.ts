import type { PostX402NetworksData, X402Network } from '@/lib/api/generated';
import { isX402ChainUsable } from '@/lib/x402-rail';

/** 0 = welcome, 1 = chain, 2 = receive, 3 = pay (optional), 4 = ready. */
export type X402SetupStep = 0 | 1 | 2 | 3 | 4;

export const X402_SETUP_STEPS = {
  welcome: 0,
  chain: 1,
  receive: 2,
  pay: 3,
  ready: 4,
} as const satisfies Record<string, X402SetupStep>;

/** Numbered steps shown in the stepper. Adding a payment source skips the paying step. */
export const X402_SETUP_STEP_LABELS = ['Chain', 'Receive payments', 'Pay other agents'];
export const X402_ADD_SOURCE_STEP_LABELS = ['Chain', 'Receive payments'];

export function initialX402SetupStep({
  isReadinessKnown,
  isReceivingReady,
  isPayingReady,
  startAtChainSelection = false,
}: {
  isReadinessKnown: boolean;
  isReceivingReady: boolean;
  isPayingReady: boolean;
  startAtChainSelection?: boolean;
}): X402SetupStep {
  if (startAtChainSelection) return X402_SETUP_STEPS.chain;
  if (!isReadinessKnown || !isReceivingReady) return X402_SETUP_STEPS.welcome;
  return isPayingReady ? X402_SETUP_STEPS.ready : X402_SETUP_STEPS.pay;
}

/** How a chain settles the payments your agents receive. */
export type X402ReceiveMode = 'node' | 'remote';

export type X402ChainSetupStatus = 'ready' | 'needs-facilitator' | 'disabled';

type ChainReadinessFields = Pick<
  X402Network,
  'isEnabled' | 'facilitatorWalletId' | 'facilitatorUrl' | 'rpcUrl'
>;

export function getX402ChainSetupStatus(chain: ChainReadinessFields): X402ChainSetupStatus {
  if (isX402ChainUsable(chain)) return 'ready';
  // Without any facilitator the receive step both assigns one and switches the chain on, so
  // a disabled chain is only reported as such when it is otherwise configured.
  if (!chain.isEnabled && (chain.facilitatorWalletId || chain.facilitatorUrl)) return 'disabled';
  return 'needs-facilitator';
}

/** An existing remote facilitator keeps the remote mode; everything else starts on this node. */
export function inferX402ReceiveMode(
  chain: Pick<X402Network, 'facilitatorUrl'> | null,
): X402ReceiveMode {
  return chain?.facilitatorUrl ? 'remote' : 'node';
}

/**
 * The chain the wizard should start on: the one the operator last selected, else the first
 * chain that can already receive, else the first chain in the environment.
 */
export function pickInitialX402Chain<T extends ChainReadinessFields & Pick<X402Network, 'id'>>(
  chains: T[],
  preferredChainId: string | null | undefined,
): T | null {
  return (
    chains.find((chain) => chain.id === preferredChainId) ??
    chains.find((chain) => isX402ChainUsable(chain)) ??
    chains[0] ??
    null
  );
}

type NetworkUpsertBody = NonNullable<PostX402NetworksData['body']>;

/**
 * Body that assigns exactly one facilitator and switches the chain on. The upsert keeps every
 * field it is not sent (the default asset in particular), so only the chain identity, the
 * facilitator and the enabled flag go out.
 */
export function buildEnableReceivingBody(
  chain: Pick<X402Network, 'caip2Id' | 'displayName' | 'rpcUrl' | 'isTestnet'>,
  receiver:
    | { mode: 'node'; sellingWalletId: string }
    | { mode: 'remote'; facilitatorUrl: string; facilitatorAuth?: string },
): NetworkUpsertBody {
  const base = {
    caip2Id: chain.caip2Id,
    displayName: chain.displayName,
    rpcUrl: chain.rpcUrl,
    isTestnet: chain.isTestnet,
    isEnabled: true,
  };
  if (receiver.mode === 'node') {
    return { ...base, facilitatorWalletId: receiver.sellingWalletId, facilitatorUrl: null };
  }
  const facilitatorAuth = receiver.facilitatorAuth?.trim();
  return {
    ...base,
    facilitatorUrl: receiver.facilitatorUrl.trim(),
    // Omitted auth keeps a stored header on the same origin; the server drops it otherwise.
    ...(facilitatorAuth ? { facilitatorAuth } : {}),
  };
}
