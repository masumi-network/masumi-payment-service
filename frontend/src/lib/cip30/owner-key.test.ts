import assert from 'node:assert/strict';
import test from 'node:test';
import { paymentKeyHashOf, walletHoldsOwnerKey } from './owner-key';

// Preprod addresses of the guarded wallet used in the live run.
const OWNER =
  'addr_test1qrpvtta6zqgrelyw8wvusktyuruz9q3vgwegjkgr067kegpylyqmd4rq6dt35f8a9l9hugzc9ux5lmcm9s7umqzk8qaqulhu7e';
const OTHER_KEY =
  'addr_test1qq3jg3ugawqced8kjhdqtw3h0ww3stq66z23zxzd995s4ykavznal58t4wq2d93lpjjq9s7009cked8dzfvkc7p3n2rswptclu';
const SCRIPT =
  'addr_test1zzvw95k0jfvkfma83mdh4uyh34yak0upukx966cuvennsd3ylyqmd4rq6dt35f8a9l9hugzc9ux5lmcm9s7umqzk8qaq2dgjdy';

test('paymentKeyHashOf reads key addresses and refuses script or bad ones', () => {
  assert.match(paymentKeyHashOf(OWNER) ?? '', /^[0-9a-f]{56}$/);
  assert.equal(paymentKeyHashOf(SCRIPT), null);
  assert.equal(paymentKeyHashOf('not-an-address'), null);
});

test('walletHoldsOwnerKey needs an address with the owner payment key', () => {
  assert.equal(walletHoldsOwnerKey([OTHER_KEY, OWNER], OWNER), true);
  assert.equal(walletHoldsOwnerKey([OTHER_KEY], OWNER), false);
  assert.equal(walletHoldsOwnerKey([], OWNER), false);
  // A script owner has no key to sign with.
  assert.equal(walletHoldsOwnerKey([SCRIPT], SCRIPT), false);
});
