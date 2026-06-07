/** Match swap HTTP handlers: if submit tx never appears on-chain within this window → timeout states. */
export const SWAP_CHAIN_SUBMIT_TIMEOUT_MS = 15 * 60 * 1000;

/** Min gap between background polls per pending swap (wallet-timeout job may run more often). */
export const SWAP_BACKGROUND_POLL_MIN_INTERVAL_MS = 10_000;
