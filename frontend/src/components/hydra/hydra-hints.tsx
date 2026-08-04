/**
 * The explanations behind the info icons on the Hydra screens.
 *
 * Kept together rather than written at each call site, because several of these
 * terms appear on three or four screens and an operator who reads two different
 * descriptions of the same period has been given a reason to doubt both.
 *
 * Each one answers the question the operator actually has, which is almost
 * never "what is this called" but "what happens to my money if I get it wrong".
 */

import { InfoHint } from '@/components/ui/info-hint';

export function DisputeWindowHint() {
  return (
    <InfoHint label="dispute window">
      <p>
        After a head closes, how long either side has to challenge the final balances with a newer
        signed snapshot.
      </p>
      <p>
        Funds cannot be withdrawn until it elapses, so a longer window is safer and slower. Both
        sides agree it when the head is opened, and it cannot be changed afterwards.
      </p>
    </InfoHint>
  );
}

export function OutOfSyncLimitHint() {
  return (
    <InfoHint label="out-of-sync limit">
      <p>How long a node may fall behind its peer before it refuses to keep transacting.</p>
      <p>
        It cannot exceed half the dispute window: a node that comes back later than that would have
        too little time left to defend the head.
      </p>
    </InfoHint>
  );
}

export function DepositPeriodHint() {
  return (
    <InfoHint label="deposit period">
      <p>
        How long a deposit waits on chain before the head will take it, and how long the window to
        take it stays open.
      </p>
      <p>
        A deposit is ignored until it is older than this period, so money added to a head is
        confirmed but unusable for that long. If the window passes unused, the deposit is recovered
        back to the wallet instead.
      </p>
    </InfoHint>
  );
}

export function HeadBalanceHint() {
  return (
    <InfoHint label="in-head balance">
      <p>What the two wallets hold inside the head right now, as of the latest signed snapshot.</p>
      <p>
        Readable only while the head is open. It is not an on-chain balance: it becomes one when the
        head closes and settles.
      </p>
    </InfoHint>
  );
}

export function NodeFundsHint() {
  return (
    <InfoHint label="node balance">
      <p>
        ADA held by the node&apos;s own key, used to pay the on-chain fees for opening, topping up
        and closing a head.
      </p>
      <p>Separate from the wallet funds inside the head, which are never spent on fees.</p>
      <p>
        One process per head, funded on its own. The menu is for when you would rather not wait, or
        want the leftovers back once a head is finished.
      </p>
    </InfoHint>
  );
}

export function InviteHint() {
  return (
    <InfoHint label="invite">
      <p>
        A signed offer to open a head with one specific counterparty, exchanged through a host
        rather than sent directly.
      </p>
      <p>
        It fixes both wallets and both periods up front, so redeeming it cannot change the terms.
        Whoever redeems it opens the head.
      </p>
    </InfoHint>
  );
}

export function HeadStatusHint() {
  return (
    <InfoHint label="head status">
      <p>
        <span className="text-foreground">Open</span> takes transactions instantly and off chain.
        Every other state does not: opening and closing are on-chain steps that take minutes.
      </p>
      <p>
        Payments fall back to the chain whenever the head is not open, so a head in transition costs
        speed, never funds.
      </p>
    </InfoHint>
  );
}

export function NodeConnectionHint() {
  return (
    <InfoHint label="connection state">
      <p>
        Whether this service can currently reach the node&apos;s API and whether the node itself has
        caught up with its peer.
      </p>
      <p>
        Both sides must be reachable and in sync before a head can be opened or take transactions.
      </p>
    </InfoHint>
  );
}
