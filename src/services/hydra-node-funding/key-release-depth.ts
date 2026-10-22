/**
 * Depth a chain fact needs before a caller may destroy a node's keys on it.
 *
 * Key deletion cannot be undone, so it does not follow the payment-sync
 * threshold down: that one defaults to 1 and accepts 0. A shallow sweep that a
 * rollback evicts would leave the funds at an address nothing here can sign
 * for, and a shallow fanout that a rollback evicts would leave an open head
 * with no node and no key to post it again. A higher configured threshold
 * still wins.
 *
 * Kept apart from `withdraw.ts` so the deletion guard can use it without
 * loading Mesh.
 */
export const KEY_RELEASE_MIN_CONFIRMATIONS = 20;
