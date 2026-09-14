import assert from 'node:assert/strict';
import { test } from 'node:test';

import { walletScopeProblem } from './wallet-scope.helpers';

test('walletScopeProblem refuses an enabled restriction with nothing selected', () => {
  // The deny-all state. The middleware reads an enabled flag with no rows as
  // `[]`, not `null`, and only `null` means unrestricted, so the key reaches no
  // wallet at all. Reachable by unticking the box and ticking it again, which
  // clears the list and leaves the checkbox exactly where it started.
  assert.match(walletScopeProblem(true, []) ?? '', /at least one wallet/);
});

test('walletScopeProblem allows an enabled restriction that names a wallet', () => {
  assert.equal(walletScopeProblem(true, ['wallet-1']), undefined);
});

test('walletScopeProblem allows a disabled restriction with an empty list', () => {
  // Unrestricted is the ordinary state for a key that never scoped anything,
  // and submit sends an empty list for it on purpose.
  assert.equal(walletScopeProblem(false, []), undefined);
});

test('walletScopeProblem ignores a stale list while the restriction is off', () => {
  // The dialogs keep the previous selection in form state while the box is
  // unticked, so re-ticking restores it instead of silently saving a deny-all.
  // That list must not make a disabled scope look like a problem.
  assert.equal(walletScopeProblem(false, ['wallet-1']), undefined);
});
