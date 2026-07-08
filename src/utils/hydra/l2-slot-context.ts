/**
 * Slot context for Hydra L2 (in-head) transaction validity windows.
 *
 * A Hydra head's ledger checks tx validity intervals against the slot timeline
 * of the L1 chain the head settles on. For a head that settles on the same
 * network masumi is configured for (e.g. a preprod head ⇄ preprod L1), the
 * static `SLOT_CONFIG_NETWORK[network]` is correct and this returns `undefined`
 * (callers fall back to the network config). A head on a *different* chain — a
 * local devnet with its own genesis — has a slot timeline the network config
 * does not describe, so its validity windows must be built from the head's own
 * slot config and anchored to the head's current slot. Without this, the head's
 * ledger rejects every time-bounded L2 tx with `OutsideValidityIntervalUTxO`.
 *
 * masumi cannot currently obtain a non-preprod head's genesis through its
 * providers (the hydra-node API does not expose it), so the override is supplied
 * out-of-band via env. Production preprod heads need none of this.
 */
import type { SlotConfig } from '@meshsdk/core';

export interface HydraL2SlotContext {
	/** Slot config of the head's L1 (zeroTime/zeroSlot in ms / slotLength in ms). */
	slotConfig: SlotConfig;
	/**
	 * The wall-clock-equivalent ms of the head's CURRENT slot. Windows anchor to
	 * this instead of `Date.now()` so they remain valid even when the head's L1 is
	 * behind real time (a stalled/slow devnet).
	 */
	nowMs: number;
	/**
	 * Validity-window buffers. A head L1 with a sub-second slot length converts
	 * the default (L1, 1s-slot) ms buffers into many more slots, which can push
	 * the upper bound past the ledger's forecast horizon (`OutsideForecast`).
	 * These let the head's config shrink the window to fit.
	 */
	beforeBufferMs: number;
	afterBufferMs: number;
	validitySlotBuffer: number;
}

/**
 * Resolve the L2 slot context from env, or `undefined` to use the configured
 * network's slot config (the production preprod path).
 *
 * Env (all required together; intended for devnet testing):
 *   HYDRA_L2_SLOT_ZERO_TIME_MS  — head L1 genesis system-start, unix ms
 *   HYDRA_L2_SLOT_LENGTH_MS     — head L1 slot length, ms (e.g. 100 for 0.1s)
 *   HYDRA_L2_CURRENT_SLOT       — head's current (tip) slot number
 */
export function getHydraL2SlotContext(): HydraL2SlotContext | undefined {
	const zeroTimeRaw = process.env.HYDRA_L2_SLOT_ZERO_TIME_MS;
	const slotLengthRaw = process.env.HYDRA_L2_SLOT_LENGTH_MS;
	const currentSlotRaw = process.env.HYDRA_L2_CURRENT_SLOT;

	if (!zeroTimeRaw || !slotLengthRaw || !currentSlotRaw) {
		return undefined;
	}

	const zeroTime = Number(zeroTimeRaw);
	const slotLength = Number(slotLengthRaw);
	const currentSlot = Number(currentSlotRaw);
	if (!Number.isFinite(zeroTime) || !Number.isFinite(slotLength) || !Number.isFinite(currentSlot) || slotLength <= 0) {
		return undefined;
	}

	// Small defaults keep the window within a stalled/slow head's forecast
	// horizon; overridable via env for other head configs.
	const beforeBufferMs = Number(process.env.HYDRA_L2_BEFORE_BUFFER_MS ?? 20_000);
	const afterBufferMs = Number(process.env.HYDRA_L2_AFTER_BUFFER_MS ?? 30_000);
	const validitySlotBuffer = Number(process.env.HYDRA_L2_VALIDITY_SLOT_BUFFER ?? 50);

	return {
		// startEpoch/epochLength are unused by unixTimeToEnclosingSlot but required
		// by the SlotConfig type; placeholders are fine for slot↔time conversion.
		slotConfig: { zeroTime, zeroSlot: 0, slotLength, startEpoch: 0, epochLength: 432000 },
		nowMs: zeroTime + currentSlot * slotLength,
		beforeBufferMs,
		afterBufferMs,
		validitySlotBuffer,
	};
}

/** Options spreadable directly into `createTxWindow` for a Hydra L2 build. */
export interface HydraL2WindowOptions {
	nowMs?: number;
	slotConfig?: SlotConfig;
	beforeBufferMs?: number;
	afterBufferMs?: number;
	validitySlotBuffer?: number;
}

/**
 * Resolve window options for an in-head tx. Precedence:
 * 1. Env devnet override (`getHydraL2SlotContext`) — a head on a different
 *    chain needs its own slot config AND anchor.
 * 2. The provider's live head clock — same-network head (production preprod):
 *    the network slot config is correct but the head's ledger clock lags
 *    wall-clock (Blockfrost poll drift, grows unbounded while the head is
 *    open), so `nowMs` must anchor to what the head last observed. Windows
 *    built off `Date.now()` get rejected with `OutsideValidityIntervalUTxO`
 *    once the lag exceeds the before-buffer.
 * 3. Empty — no head clock seen yet on the websocket; fall back to wall clock
 *    (pre-fix behavior) rather than blocking the tx entirely.
 */
export function resolveHydraL2WindowOptions(provider: {
	getHeadClock(): { chainTimeMs: number } | undefined;
}): HydraL2WindowOptions {
	const envCtx = getHydraL2SlotContext();
	if (envCtx) {
		return {
			nowMs: envCtx.nowMs,
			slotConfig: envCtx.slotConfig,
			beforeBufferMs: envCtx.beforeBufferMs,
			afterBufferMs: envCtx.afterBufferMs,
			validitySlotBuffer: envCtx.validitySlotBuffer,
		};
	}
	const headClock = provider.getHeadClock();
	if (headClock) {
		return { nowMs: headClock.chainTimeMs };
	}
	return {};
}

/**
 * How many ms the head's clock still has to advance before a tx constrained
 * by `must_start_after(cooldownMs)` can validate in-head. When > 0, submitting
 * is pointless — the head will reject `OutsideValidityIntervalUTxO` until its
 * observed chain time passes the cooldown — so callers should defer and let
 * the cron retry. 0 means safe to build/submit (also when no head anchor is
 * known: wall-clock semantics apply and the pre-existing behavior stands).
 */
export function headClockBehindCooldownMs(options: HydraL2WindowOptions, cooldownMs: number | bigint): number {
	if (options.nowMs == null) return 0;
	const cooldown = typeof cooldownMs === 'bigint' ? Number(cooldownMs) : cooldownMs;
	return Math.max(0, cooldown - options.nowMs);
}
