/** Result of `POST /hydra/head/chain-check`, and how it reads to an operator. */

export type HydraHeadChainCheck = {
  isOpenOnChain: boolean;
  latestTxHash: string;
  nodeStart: 'requested' | 'head-closing' | 'no-participant' | 'no-admin-token' | 'failed' | null;
};

/** What the operator reads after a check. */
export function describeHydraHeadChainCheck(result: HydraHeadChainCheck): string {
  if (result.isOpenOnChain) {
    return 'Still open on chain. The node stays stopped, and the service keeps checking.';
  }
  switch (result.nodeStart) {
    case 'requested':
      return 'No longer open on chain. The node was asked to start, so it can contest the close.';
    case 'no-admin-token':
      return 'No longer open on chain, but this host has no admin token. Start the node on the host now, so it can contest the close.';
    default:
      return 'No longer open on chain, and the node could not be started. Start it on the host now, so it can contest the close.';
  }
}
