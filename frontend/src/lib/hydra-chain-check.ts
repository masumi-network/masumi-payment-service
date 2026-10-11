/** Result of `POST /hydra/head/chain-check`, and how it reads to an operator. */

export type HydraHeadChainCheck = {
  chainState: 'open' | 'closed' | 'gone';
  latestTxHash: string;
};

/** What the operator reads after a check. */
export function describeHydraHeadChainCheck(result: HydraHeadChainCheck): string {
  switch (result.chainState) {
    case 'open':
      return 'Still open on chain. Its node keeps running, so L2 refunds and withdrawals still work. Payments the counterparty locks in it fail until the head is re-enabled.';
    case 'closed':
      return 'Closed on chain, and the contestation period is running. A running node contests a stale close by itself: make sure this head’s node runs on the host.';
    case 'gone':
      return 'Fanned out on chain. The head is finished.';
  }
}
