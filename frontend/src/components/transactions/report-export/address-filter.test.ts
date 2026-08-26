import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addAddresses, parseAddressEntries } from './address-filter';

const FIRST = 'addr_test1qzbuya0000000000000000000000000000000000000000000000000q2wn7cf';
const SECOND = 'addr_test1qzextbuyer00000000000000000000000000000000000000000000q8fh2we';

describe('report address filter', () => {
  it('splits a pasted list on commas, spaces, and new lines', () => {
    assert.deepEqual(parseAddressEntries(` ${FIRST}, ${SECOND}\n${FIRST} `), [FIRST, SECOND]);
  });

  it('adds every valid address from one paste', () => {
    const result = addAddresses([], `${FIRST}, ${SECOND}`);
    assert.deepEqual(result.addresses, [FIRST, SECOND]);
  });

  it('rejects the whole paste when one entry is not an address', () => {
    const result = addAddresses([], `${FIRST}, not-an-address`);
    assert.equal(result.addresses, null);
    assert.match(result.error ?? '', /not a Cardano address/);
  });

  it('rejects a mainnet-looking string that is too short to be an address', () => {
    assert.equal(addAddresses([], 'addr1q0').addresses, null);
  });

  it('accepts mainnet and stake addresses', () => {
    const mainnet = `addr1${'q'.repeat(40)}`;
    const stake = `stake_test1${'u'.repeat(40)}`;
    assert.deepEqual(addAddresses([], `${mainnet} ${stake}`).addresses, [mainnet, stake]);
  });

  it('names a duplicate instead of silently keeping the list unchanged', () => {
    const result = addAddresses([FIRST], FIRST);
    assert.equal(result.addresses, null);
    assert.equal(result.error, 'That address is already on the list.');
  });

  it('refuses to pass the API limit of 100 addresses', () => {
    const filled = Array.from({ length: 100 }, (_, index) => `addr_test1${'q'.repeat(20)}${index}`);
    const result = addAddresses(filled, SECOND);
    assert.equal(result.addresses, null);
    assert.match(result.error ?? '', /at most 100 addresses/);
  });
});
