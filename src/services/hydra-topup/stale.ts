/**
 * When an in-flight top-up row is treated as abandoned. Shared by the top-up
 * claim, which fails such a row, and the Host pause, which stops waiting for it.
 */

/**
 * After this, a Preparing row is treated as abandoned.
 *
 * Nothing resolves such a row on its own: it has no deposit hash, so
 * reconciliation has nothing to look for, and the request that owns it is long
 * gone. Since Preparing also blocks the next top-up, leaving it would let one
 * crashed carve wedge the head's deposits for good. Comfortably longer than the
 * carve's own confirmation budget, so a slow chain is never mistaken for a
 * crash.
 */
export const PREPARING_STALE_AFTER_MS = 30 * 60 * 1000;
