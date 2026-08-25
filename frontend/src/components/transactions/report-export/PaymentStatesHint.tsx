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
    </InfoHint>
  );
}
