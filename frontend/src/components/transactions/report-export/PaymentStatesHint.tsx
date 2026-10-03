import { InfoHint } from '@/components/ui/info-hint';

/**
 * The state filter is easy to misread as "which payments count as revenue".
 *
 * It is not that. It drops whole requests from the report, fees included, while
 * the revenue mode decides when money counts. Saying so at the field itself is
 * cheaper than explaining a total that fell for no visible reason.
 */
export function PaymentStatesHint() {
  return (
    <InfoHint label="payment states">
      <p>
        Chooses which requests appear at all. Leave every box clear to include all of them, which is
        the normal setting.
      </p>
      <p>
        This does not decide when money counts. That is the job of &ldquo;Count revenue when it
        is&rdquo;, which already counts work as earned once the escrow unlocks, before any
        withdrawal.
      </p>
      <p>
        So picking only <em>Withdrawn</em> does not give you settled revenue. It removes every
        request that has not been withdrawn yet, together with its fees, and the totals drop.
      </p>
      <p>
        Unfinished requests are included as rows. A submitted result whose dispute window is still
        open earns nothing yet, so it sits in no period and is marked as an estimate rather than
        counted as zero.
      </p>
      <p>
        Once the window closes, that revenue lands on the unlock day, not on the day you ran the
        report. A request that is later disputed or refunded moves again, so the same period can
        report a different figure after an escrow resolves.
      </p>
      <p>
        A closed dispute window is not a state of its own. Such a request stays{' '}
        <em>Result submitted</em> until the seller withdraws, so it is not listed under{' '}
        <em>Withdrawn</em> and cannot be picked apart from one whose window is still open.
      </p>
      <p>
        States marked <em>Final</em> end the escrow. A request reaches at most one of them and
        nothing moves afterwards, so those figures will not be restated.
      </p>
    </InfoHint>
  );
}
