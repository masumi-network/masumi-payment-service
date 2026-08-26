/**
 * The address filter, as data rules.
 *
 * The report matches these strings exactly against the counterparty, payout,
 * and return address, so a typo returns nothing rather than an error. The
 * dialog therefore checks an address before it can join the list.
 */

/** Both limits come from the report API schema. */
export const MAX_ADDRESS_LENGTH = 250;
export const MAX_ADDRESSES = 100;

/**
 * The check stays on the prefix, the bech32 separator, and the length. A
 * stricter bech32 alphabet would also reject addresses this service stores in
 * its own test data, and a false rejection is worse here than a typo that
 * simply matches no request.
 */
const CARDANO_ADDRESS = /^(addr|addr_test|stake|stake_test)1[0-9a-z]{20,}$/;

/** Splits pasted text on commas, spaces, and new lines, keeping first order. */
export function parseAddressEntries(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

export type AddressAddResult =
  | Readonly<{ addresses: readonly string[]; error: null; invalidAddress: null }>
  | Readonly<{ addresses: null; error: string; invalidAddress: string | null }>;

/** Adds one or many pasted addresses, or explains why none of them was added. */
export function addAddresses(current: readonly string[], draft: string): AddressAddResult {
  const entries = parseAddressEntries(draft);
  if (entries.length === 0) {
    return { addresses: null, error: 'Enter an address first.', invalidAddress: null };
  }

  const tooLong = entries.find((entry) => entry.length > MAX_ADDRESS_LENGTH);
  if (tooLong) {
    return {
      addresses: null,
      error: `An address may hold at most ${MAX_ADDRESS_LENGTH} characters.`,
      invalidAddress: null,
    };
  }

  const invalid = entries.find((entry) => !CARDANO_ADDRESS.test(entry));
  if (invalid) {
    return {
      addresses: null,
      error: `${invalid} is not a Cardano address.`,
      invalidAddress: invalid,
    };
  }

  const merged = [...new Set([...current, ...entries])];
  if (merged.length > MAX_ADDRESSES) {
    return {
      addresses: null,
      error: `The report accepts at most ${MAX_ADDRESSES} addresses.`,
      invalidAddress: null,
    };
  }
  if (merged.length === current.length) {
    return {
      addresses: null,
      error: entries.length === 1 ? 'That address is already on the list.' : 'No new addresses.',
      invalidAddress: null,
    };
  }
  return { addresses: merged, error: null, invalidAddress: null };
}
