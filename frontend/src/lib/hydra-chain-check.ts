/** Result of `POST /hydra/head/chain-check`, and how it reads to an operator. */

export type HydraHeadNodeOutcome =
  | 'requested'
  | 'head-closing'
  | 'no-participant'
  | 'no-admin-token'
  | 'failed';

export type HydraHeadChainCheck = {
  chainState: 'open' | 'closed' | 'gone';
  latestTxHash: string;
  nodeAction: 'stop' | 'start' | null;
  nodeOutcome: HydraHeadNodeOutcome | null;
};

/** True when the operator has to act on the host now. */
export function needsOperatorAction(result: HydraHeadChainCheck): boolean {
  if (result.nodeAction === 'start') return result.nodeOutcome !== 'requested';
  if (result.nodeAction === 'stop') {
    return result.nodeOutcome !== 'requested' && result.nodeOutcome !== 'head-closing';
  }
  return false;
}

/** What the operator reads after a check. */
export function describeHydraHeadChainCheck(result: HydraHeadChainCheck): string {
  if (result.chainState === 'gone') {
    return 'Fanned out on chain. The head is finished, so its node is no longer needed.';
  }
  const noToken = result.nodeOutcome === 'no-admin-token' ? ' This host has no admin token.' : '';
  if (result.chainState === 'closed') {
    if (result.nodeOutcome === 'requested') {
      return 'Closed on chain. The host was asked to start the node, so it can contest the close.';
    }
    return `Closed on chain, and the node could not be started.${noToken} Start it on the host now, so it can contest the close.`;
  }
  if (result.nodeAction === null) {
    return 'Open on chain. The head is enabled again, so its node keeps running.';
  }
  if (result.nodeAction === 'start') {
    if (result.nodeOutcome === 'requested') {
      return 'Open on chain. The head was enabled again during the check, so the host was asked to start the node again.';
    }
    return `Open on chain. The head was enabled again during the check, but its node could not be started.${noToken} Start it on the host now.`;
  }
  if (result.nodeOutcome === 'requested') {
    return 'Open on chain. The host was asked to stop the node, so the counterparty stops using this head. The service keeps checking.';
  }
  if (result.nodeOutcome === 'head-closing') {
    return 'Open on chain, but this side is closing the head, so the node stays up to finish the close.';
  }
  return `Open on chain, and the node could not be stopped.${noToken} The counterparty can still lock funds in this head. Stop the node on the host.`;
}
