# Hydra L2 Head-Clock-Anchored Tx Windows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate `OutsideValidityIntervalUTxO` rejections of Hydra L2 escrow transactions by anchoring their validity windows to the head's own observed chain clock instead of `Date.now()`.

**Architecture:** The hydra-node's API websocket broadcasts its observed L1 chain time (`Tick` messages on release builds; `SyncedStatusReport` on current master/Blockfrost builds — both carry `chainTime` + `chainSlot`). `HydraNode` will passively track the latest such message; `HydraProvider` exposes it; a new `resolveHydraL2SlotContext()` turns it into `createTxWindow` options so every L2 build path anchors `nowMs` to the head's clock. Services with cooldown constraints defer (via the existing `LOOKUP_DEFERRED_PREFIX` retry mechanism) when the head clock hasn't reached the cooldown yet, instead of submitting a doomed tx.

**Tech Stack:** TypeScript, Jest (`jest.unstable_mockModule` ESM mocks), zod schemas in `src/lib/hydra/hydra/schemas.ts`, existing `createTxWindow` in `src/services/shared/tx-window.ts`.

## Why (verified root cause, 2026-07-08 run)

- The head validates tx validity intervals against **its own** clock, fed by its Blockfrost poll loop, which lags real time by a **growing** amount (measured: ~5 min at 06:02 → ~13.4 min at 06:30 → `drift: 7735s` in `SyncedStatusReport` by 09:28).
- `createTxWindow` defaults `invalidBefore = Date.now() − 5 min` (`timeBufferMs: 300000`, `packages/payment-core/src/config.ts:353`). Once head lag > 5 min, every L2 tx starts "in the future" from the head's perspective → `OutsideValidityIntervalUTxO`, and rebuilding on retry re-anchors to fresh real time so it never recovers. This killed flow3's authorize-withdrawal (both attempts) in the 2026-07-08 preprod run.
- The env-var-based `getHydraL2SlotContext()` (`src/utils/hydra/l2-slot-context.ts`) already solves this for devnet heads via **static** env vars; it returns `undefined` on preprod. This plan makes the same anchoring **dynamic** and automatic.

## Global Constraints

- **Mesh SDK version isolation (ADR-0005):** files under `src/` stay on the V1 mesh line; files under `packages/payment-source-v2/` on V2. This plan only adds *type* imports from `@meshsdk/core` in `src/` (already present) and touches no mesh build code — do not add new runtime mesh imports across the boundary.
- Import Zod from `@/utils/zod-openapi` in `src/routes`; plain zod usage inside `src/lib/hydra/hydra/schemas.ts` follows that file's existing convention.
- Use `logger` from `@masumi/payment-core/logger` or `@/utils/logger` — never `console.log`.
- BigInt for monetary/time-datum values; `Number()` conversion only where `tx-window.ts` already documents it safe.
- Formatting: single quotes, 2-space… follow `pnpm run format`. Run `pnpm run lint` before each commit.
- Conventional commits, header < 72 chars, lowercase type.
- Test runner: `pnpm run test -- <path>` (Jest ESM).

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/lib/hydra/hydra/schemas.ts` | Modify | Add `headClockMessageSchema` parsing `Tick`/`SyncedStatusReport` |
| `src/lib/hydra/hydra/node.ts` | Modify | Track latest head clock from ws messages; expose `headClock` getter; add to `IHydraNode` |
| `src/lib/hydra/hydra/node.spec.ts` | Modify | Tests for head-clock tracking |
| `src/lib/hydra/hydra/provider.ts` | Modify | Expose `getHeadClock()` |
| `src/lib/hydra/hydra/provider.spec.ts` | Modify | Test for provider passthrough |
| `src/utils/hydra/l2-slot-context.ts` | Modify | Add `HydraHeadClock` type, `resolveHydraL2SlotContext(provider)`, `deferIfHeadClockBehind()` |
| `src/utils/hydra/l2-slot-context.spec.ts` | Create | Tests for resolution precedence + deferral |
| 6 service files under `packages/payment-source-v2/src/services/**` | Modify | Use resolved context in L2 paths |
| `hydra-l2-flow/run-hydra-e2e.sh` | Modify | Drift-aware head-clock wait cap |

---

### Task 1: Head-clock message schema

**Files:**
- Modify: `src/lib/hydra/hydra/schemas.ts`
- Test: `src/lib/hydra/hydra/schemas.spec.ts`

**Interfaces:**
- Produces: `headClockMessageSchema` (zod), parsing `{ tag: 'Tick' | 'SyncedStatusReport', chainTime: string (ISO), chainSlot?: number }` → later tasks import it from `./schemas`.

- [ ] **Step 1: Write the failing tests** — append to `src/lib/hydra/hydra/schemas.spec.ts` (follow the file's existing describe/import style):

```typescript
describe('headClockMessageSchema', () => {
	it('parses a Tick message', () => {
		const parsed = headClockMessageSchema.parse({
			tag: 'Tick',
			chainTime: '2026-07-08T07:19:17Z',
			chainSlot: 127811957,
		});
		expect(parsed.tag).toBe('Tick');
		expect(parsed.chainTime).toBe('2026-07-08T07:19:17Z');
		expect(parsed.chainSlot).toBe(127811957);
	});

	it('parses a SyncedStatusReport message (extra fields ignored)', () => {
		const parsed = headClockMessageSchema.parse({
			tag: 'SyncedStatusReport',
			chainSlot: 127811957,
			chainTime: '2026-07-08T07:19:17Z',
			drift: 7735.89,
			synced: 'CatchingUp',
		});
		expect(parsed.tag).toBe('SyncedStatusReport');
	});

	it('rejects other tags', () => {
		expect(() => headClockMessageSchema.parse({ tag: 'Greetings', chainTime: 'x' })).toThrow();
	});

	it('rejects missing chainTime', () => {
		expect(() => headClockMessageSchema.parse({ tag: 'Tick', chainSlot: 5 })).toThrow();
	});
});
```

Add the import at the top of the spec: `headClockMessageSchema` from `./schemas`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm run test -- src/lib/hydra/hydra/schemas.spec.ts`
Expected: FAIL — `headClockMessageSchema` is not exported.

- [ ] **Step 3: Implement** — in `src/lib/hydra/hydra/schemas.ts`, alongside the existing schemas (same zod import the file already uses):

```typescript
/**
 * Head chain-clock broadcast: release hydra-nodes emit `Tick` on the API
 * websocket for every observed L1 block; Blockfrost-backed master builds emit
 * `SyncedStatusReport` (which additionally carries `drift`/`synced`). Both
 * carry the head's observed L1 time — the clock its ledger validates tx
 * validity intervals against. `chainSlot` is optional because older release
 * `Tick`s carried only `chainTime`.
 */
export const headClockMessageSchema = z.object({
	tag: z.enum(['Tick', 'SyncedStatusReport']),
	chainTime: z.string(),
	chainSlot: z.number().optional(),
});
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm run test -- src/lib/hydra/hydra/schemas.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/hydra/hydra/schemas.ts src/lib/hydra/hydra/schemas.spec.ts
git commit -m "feat(hydra): add head clock message schema (Tick/SyncedStatusReport)"
```

---

### Task 2: HydraNode head-clock tracking

**Files:**
- Modify: `src/lib/hydra/hydra/node.ts`
- Test: `src/lib/hydra/hydra/node.spec.ts`

**Interfaces:**
- Consumes: `headClockMessageSchema` from Task 1.
- Produces: `export interface HydraHeadClock { chainTimeMs: number; chainSlot?: number; receivedAtMs: number }` and `get headClock(): HydraHeadClock | undefined` on `HydraNode` + `IHydraNode`.

- [ ] **Step 1: Write the failing tests** — append to `node.spec.ts` (it already has `MockConnection` + `mockConnectionInstance` that the node subscribes to; emitting `'message'` reaches the node's handlers):

```typescript
describe('head clock tracking', () => {
	it('captures chainTime/chainSlot from a Tick message', () => {
		const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
		node.connect();
		mockConnectionInstance.emit(
			'message',
			JSON.stringify({ tag: 'Tick', chainTime: '2026-07-08T07:19:17Z', chainSlot: 127811957 }),
		);
		expect(node.headClock).toBeDefined();
		expect(node.headClock!.chainTimeMs).toBe(Date.parse('2026-07-08T07:19:17Z'));
		expect(node.headClock!.chainSlot).toBe(127811957);
		expect(node.headClock!.receivedAtMs).toBeGreaterThan(0);
	});

	it('captures the clock from a SyncedStatusReport message', () => {
		const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
		node.connect();
		mockConnectionInstance.emit(
			'message',
			JSON.stringify({
				tag: 'SyncedStatusReport',
				chainSlot: 127811957,
				chainTime: '2026-07-08T07:19:17Z',
				drift: 7735.89,
				synced: 'CatchingUp',
			}),
		);
		expect(node.headClock!.chainTimeMs).toBe(Date.parse('2026-07-08T07:19:17Z'));
	});

	it('keeps the newest clock and ignores unrelated/invalid messages', () => {
		const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
		node.connect();
		mockConnectionInstance.emit(
			'message',
			JSON.stringify({ tag: 'Tick', chainTime: '2026-07-08T07:00:00Z', chainSlot: 1 }),
		);
		mockConnectionInstance.emit('message', JSON.stringify({ tag: 'Greetings', headStatus: 'Open' }));
		mockConnectionInstance.emit('message', 'not-json');
		mockConnectionInstance.emit(
			'message',
			JSON.stringify({ tag: 'Tick', chainTime: '2026-07-08T07:19:17Z', chainSlot: 2 }),
		);
		expect(node.headClock!.chainSlot).toBe(2);
	});

	it('returns undefined before any clock message', () => {
		const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
		node.connect();
		expect(node.headClock).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm run test -- src/lib/hydra/hydra/node.spec.ts`
Expected: FAIL — `headClock` does not exist.

- [ ] **Step 3: Implement** — in `node.ts`:

Add to imports from `./schemas`: `headClockMessageSchema`.

Add the exported type near `HydraRawCostModels`:

```typescript
/**
 * The head's last observed L1 chain time, from the API websocket's
 * `Tick`/`SyncedStatusReport` broadcasts. This is the clock the head's ledger
 * checks tx validity intervals against — it can lag wall-clock time by many
 * minutes (Blockfrost-backed chain followers drift), so L2 validity windows
 * must anchor to it, not to `Date.now()`. `receivedAtMs` lets consumers judge
 * staleness.
 */
export interface HydraHeadClock {
	chainTimeMs: number;
	chainSlot?: number;
	receivedAtMs: number;
}
```

Add to `IHydraNode` (after `get wsUrl(): string;`):

```typescript
	get headClock(): HydraHeadClock | undefined;
```

In `HydraNode`: add field `private _headClock: HydraHeadClock | undefined;`, subscribe in `connect()` next to the two existing listeners:

```typescript
			this._connection.on('message', (data) => this.processHeadClock(data));
```

and add the handler + getter:

```typescript
	private processHeadClock(rawMessage: string) {
		try {
			const parsed = headClockMessageSchema.safeParse(JSON.parse(rawMessage));
			if (!parsed.success) return;
			const chainTimeMs = Date.parse(parsed.data.chainTime);
			if (Number.isNaN(chainTimeMs)) return;
			this._headClock = {
				chainTimeMs,
				chainSlot: parsed.data.chainSlot,
				receivedAtMs: Date.now(),
			};
		} catch {
			// non-JSON frames are other consumers' problem; the clock just skips them
		}
	}

	get headClock(): HydraHeadClock | undefined {
		return this._headClock;
	}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm run test -- src/lib/hydra/hydra/node.spec.ts`
Expected: PASS (all pre-existing tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/hydra/hydra/node.ts src/lib/hydra/hydra/node.spec.ts
git commit -m "feat(hydra): track head chain clock from ws Tick/SyncedStatusReport"
```

---

### Task 3: HydraProvider passthrough

**Files:**
- Modify: `src/lib/hydra/hydra/provider.ts`
- Test: `src/lib/hydra/hydra/provider.spec.ts`

**Interfaces:**
- Consumes: `HydraHeadClock`, `IHydraNode.headClock` from Task 2.
- Produces: `HydraProvider.getHeadClock(): HydraHeadClock | undefined` — consumed by Task 4.

- [ ] **Step 1: Write the failing test** — append to `provider.spec.ts`, following its existing mock-node pattern (it constructs `HydraProvider` with a mock `IHydraNode`; extend the mock object with a `headClock` getter):

```typescript
describe('getHeadClock', () => {
	it('returns the node headClock', () => {
		const clock = { chainTimeMs: 1751959157000, chainSlot: 127811957, receivedAtMs: Date.now() };
		const provider = new HydraProvider({
			node: { ...mockNode, headClock: clock } as unknown as IHydraNode,
		});
		expect(provider.getHeadClock()).toEqual(clock);
	});
});
```

(Adapt `mockNode` to whatever the spec file names its mock; if it builds mocks inline, add `headClock: clock` to that inline object. The `IHydraNode` type import may need adding.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm run test -- src/lib/hydra/hydra/provider.spec.ts`
Expected: FAIL — `getHeadClock` is not a function.

- [ ] **Step 3: Implement** — in `provider.ts`, import type `HydraHeadClock` from `./node` and add below `fetchRawCostModels`:

```typescript
	/**
	 * The head's last observed L1 chain time (see `HydraHeadClock`). L2 tx
	 * validity windows must anchor here: the head's ledger clock can lag
	 * wall-clock by more than the default window buffers, in which case
	 * `Date.now()`-anchored windows are rejected with
	 * `OutsideValidityIntervalUTxO`.
	 */
	getHeadClock(): HydraHeadClock | undefined {
		return this._node.headClock;
	}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm run test -- src/lib/hydra/hydra/provider.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/hydra/hydra/provider.ts src/lib/hydra/hydra/provider.spec.ts
git commit -m "feat(hydra): expose head clock on HydraProvider"
```

---

### Task 4: Dynamic slot-context resolution + cooldown deferral helper

**Files:**
- Modify: `src/utils/hydra/l2-slot-context.ts`
- Create: `src/utils/hydra/l2-slot-context.spec.ts`

**Interfaces:**
- Consumes: `HydraHeadClock` (structural type, no import needed from `src/lib` — accept `{ getHeadClock(): { chainTimeMs: number } | undefined }`).
- Produces (consumed by Task 5 service edits):

```typescript
export interface HydraL2WindowOptions {
	nowMs?: number;
	slotConfig?: SlotConfig;
	beforeBufferMs?: number;
	afterBufferMs?: number;
	validitySlotBuffer?: number;
}
export function resolveHydraL2WindowOptions(provider: {
	getHeadClock(): { chainTimeMs: number } | undefined;
}): HydraL2WindowOptions;
export function headClockBehindCooldownMs(
	options: HydraL2WindowOptions,
	cooldownMs: number | bigint,
): number; // 0 when submit is safe
```

- [ ] **Step 1: Write the failing tests** — create `src/utils/hydra/l2-slot-context.spec.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
	getHydraL2SlotContext,
	headClockBehindCooldownMs,
	resolveHydraL2WindowOptions,
} from './l2-slot-context';

const ENV_KEYS = ['HYDRA_L2_SLOT_ZERO_TIME_MS', 'HYDRA_L2_SLOT_LENGTH_MS', 'HYDRA_L2_CURRENT_SLOT'] as const;

describe('resolveHydraL2WindowOptions', () => {
	const saved: Record<string, string | undefined> = {};
	beforeEach(() => {
		for (const k of ENV_KEYS) {
			saved[k] = process.env[k];
			delete process.env[k];
		}
	});
	afterEach(() => {
		for (const k of ENV_KEYS) {
			if (saved[k] == null) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	it('prefers the env devnet override when set', () => {
		process.env.HYDRA_L2_SLOT_ZERO_TIME_MS = '1000';
		process.env.HYDRA_L2_SLOT_LENGTH_MS = '100';
		process.env.HYDRA_L2_CURRENT_SLOT = '50';
		const opts = resolveHydraL2WindowOptions({ getHeadClock: () => ({ chainTimeMs: 999999 }) });
		expect(opts.nowMs).toBe(1000 + 50 * 100);
		expect(opts.slotConfig).toBeDefined();
	});

	it('anchors nowMs to the provider head clock when no env override', () => {
		const opts = resolveHydraL2WindowOptions({ getHeadClock: () => ({ chainTimeMs: 1751959157000 }) });
		expect(opts.nowMs).toBe(1751959157000);
		expect(opts.slotConfig).toBeUndefined(); // network config applies
	});

	it('returns empty options when neither env nor head clock is available', () => {
		const opts = resolveHydraL2WindowOptions({ getHeadClock: () => undefined });
		expect(opts).toEqual({});
	});
});

describe('headClockBehindCooldownMs', () => {
	it('returns 0 when the head clock passed the cooldown', () => {
		expect(headClockBehindCooldownMs({ nowMs: 2_000 }, 1_500n)).toBe(0);
	});

	it('returns the gap when the head clock is behind the cooldown', () => {
		expect(headClockBehindCooldownMs({ nowMs: 1_000 }, 1_500)).toBe(500);
	});

	it('returns 0 when there is no head anchor (Date.now() semantics unchanged)', () => {
		expect(headClockBehindCooldownMs({}, Date.now() - 60_000)).toBe(0);
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm run test -- src/utils/hydra/l2-slot-context.spec.ts`
Expected: FAIL — new exports missing.

- [ ] **Step 3: Implement** — append to `src/utils/hydra/l2-slot-context.ts` (keep `getHydraL2SlotContext` and its env contract untouched):

```typescript
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
export function headClockBehindCooldownMs(
	options: HydraL2WindowOptions,
	cooldownMs: number | bigint,
): number {
	if (options.nowMs == null) return 0;
	const cooldown = typeof cooldownMs === 'bigint' ? Number(cooldownMs) : cooldownMs;
	return Math.max(0, cooldown - options.nowMs);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm run test -- src/utils/hydra/l2-slot-context.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/utils/hydra/l2-slot-context.ts src/utils/hydra/l2-slot-context.spec.ts
git commit -m "feat(hydra): resolve l2 window options from live head clock"
```

---

### Task 5: Wire head-anchored windows into the six L2 service paths

**Files (Modify — the L2 single-item path in each):**
1. `packages/payment-source-v2/src/services/purchases/authorize-withdrawal/service.ts` (~line 1064)
2. `packages/payment-source-v2/src/services/payments/collection/service.ts`
3. `packages/payment-source-v2/src/services/payments/submit-result/service.ts`
4. `packages/payment-source-v2/src/services/payments/authorize-refund/service.ts` (~line 1049)
5. `packages/payment-source-v2/src/services/purchases/request-refund/service.ts`
6. `packages/payment-source-v2/src/services/purchases/collect-refund/service.ts`

**Interfaces:**
- Consumes: `resolveHydraL2WindowOptions`, `headClockBehindCooldownMs` from Task 4 (import from `@/utils/hydra/l2-slot-context`, replacing the `getHydraL2SlotContext` import); each L2 path's in-scope `hydraProvider` (already obtained from `getHydraConnectionManager().getProvider(headId)`); each file's existing `LOOKUP_DEFERRED_PREFIX` constant.
- Produces: no new exports; behavioral change only.

Every file follows the **same transformation**. Locate the L2 path's window construction with:

```bash
grep -n "getHydraL2SlotContext" packages/payment-source-v2/src/services -r
```

Current pattern (verbatim from authorize-withdrawal; other files differ only in the `constrainBeforeMs` expression and surrounding datum code):

```typescript
	const l2SlotCtx = getHydraL2SlotContext();
	const { invalidBefore, invalidAfter } = createTxWindow(network, {
		constrainBeforeMs: decodedContract.buyerCooldownTime,
		...(l2SlotCtx
			? {
					slotConfig: l2SlotCtx.slotConfig,
					nowMs: l2SlotCtx.nowMs,
					beforeBufferMs: l2SlotCtx.beforeBufferMs,
					afterBufferMs: l2SlotCtx.afterBufferMs,
					validitySlotBuffer: l2SlotCtx.validitySlotBuffer,
				}
			: {}),
	});
```

Replacement (adjust `constrainBeforeMs` per file; keep each file's exact cooldown expression — collection derives it from `sellerCooldownTime`/`unlockTime`, authorize-refund uses `sellerCooldownTime`, authorize-withdrawal uses `buyerCooldownTime`, etc.):

```typescript
	const l2WindowOptions = resolveHydraL2WindowOptions(hydraProvider);
	const headBehindMs = headClockBehindCooldownMs(l2WindowOptions, decodedContract.buyerCooldownTime);
	if (headBehindMs > 0) {
		throw new Error(
			`${LOOKUP_DEFERRED_PREFIX} head clock is ${Math.ceil(headBehindMs / 1000)}s behind the cooldown expiry; retry next tick`,
		);
	}
	const { invalidBefore, invalidAfter } = createTxWindow(network, {
		constrainBeforeMs: decodedContract.buyerCooldownTime,
		...l2WindowOptions,
	});
```

For files whose L2 path has **no** `constrainBeforeMs` (check each; e.g. request-refund/submit-result may constrain differently or not at all), apply only the window-options change — no deferral guard:

```typescript
	const l2WindowOptions = resolveHydraL2WindowOptions(hydraProvider);
	const { invalidBefore, invalidAfter } = createTxWindow(network, {
		...l2WindowOptions,
	});
```

**Guard subtlety:** in files where the deferral guard is added, confirm `LOOKUP_DEFERRED_PREFIX` exists in that file (authorize-withdrawal has it; if a file lacks it, import/replicate the same deferred-lookup convention that file's other deferral errors use — search the file for `retry next tick`).

- [ ] **Step 1: Update the six files** per the pattern above (also update each file's import: `getHydraL2SlotContext` → `resolveHydraL2WindowOptions, headClockBehindCooldownMs`).

- [ ] **Step 2: Verify no stale imports remain**

Run: `grep -rn "getHydraL2SlotContext" packages/payment-source-v2/src`
Expected: no matches (the function stays exported for the env/devnet path inside `l2-slot-context.ts` itself, but no service imports it directly).

- [ ] **Step 3: Run the affected service test suites**

Run: `pnpm run test -- packages/payment-source-v2`
Expected: PASS. If existing specs stub `getHydraL2SlotContext`, update the stubs to mock `resolveHydraL2WindowOptions` returning `{}` (preserves prior test semantics) and add one case per service asserting the deferral throw when `resolveHydraL2WindowOptions` returns `{ nowMs: <before cooldown> }`:

```typescript
	it('defers L2 build when the head clock is behind the cooldown', async () => {
		// arrange: mock resolveHydraL2WindowOptions → { nowMs: Number(cooldown) - 60_000 }
		// act + assert: expect the L2 path to throw with LOOKUP_DEFERRED_PREFIX
	});
```

(Write the arrange/act/assert concretely per each spec file's existing harness — they already mock the hydra connection manager.)

- [ ] **Step 4: Full check**

Run: `pnpm run lint && pnpm run build && pnpm run test`
Expected: all green (736+ tests).

- [ ] **Step 5: Commit**

```bash
git add packages/payment-source-v2/src
git commit -m "fix(hydra): anchor L2 tx windows to head clock, defer behind-cooldown builds"
```

---

### Task 6: Harness — drift-aware waits

**Files:**
- Modify: `hydra-l2-flow/run-hydra-e2e.sh` (head-clock wait, ~line 473; retry delay near the `retrying once in 90s` message)

**Interfaces:**
- Consumes: existing `node_drift` helper in `hydra-l2-flow/hydra-native.sh:333` (prints seconds of head lag).

Changes (bash, follow the script's existing style):

- [ ] **Step 1: Raise the head-clock wait cap and make it drift-aware.** In the wait function at `run-hydra-e2e.sh:473-490`, replace the fixed `600` cap:

```bash
    # Cap = measured drift + margin: the head clock reaches a fixed wall-time
    # target `drift` seconds late, so a fixed 600s cap fails whenever drift
    # exceeds it (2026-07-08: 803s drift → auth-wd rejected twice).
    local drift; drift="$(node_drift "$NATIVE_LOG")"
    [ "$drift" -ge 999999 ] && drift=600
    local cap=$(( drift + 300 ))
    [ "$cap" -lt 900 ] && cap=900
```

and use `$cap` where `600` was used.

- [ ] **Step 2: Make the single retry delay drift-aware too** — where the script sleeps `90` before the retry, compute the remaining gap the same way (target time vs latest Tick `chainTime`) and sleep `gap + 30` capped at `$cap`. With the Task-5 service fix in place, the service itself now defers instead of submitting doomed txs, so this is belt-and-braces for the harness's direct submissions.

- [ ] **Step 3: Syntax-check and dry-run**

Run: `bash -n hydra-l2-flow/run-hydra-e2e.sh`
Expected: no output (clean parse).

- [ ] **Step 4: Commit**

```bash
git add hydra-l2-flow/run-hydra-e2e.sh
git commit -m "fix(hydra-e2e): drift-aware head-clock wait cap and retry delay"
```

---

### Task 7: Preprod validation run

**Files:** none (operational validation; follow `hydra-fresh-run-reset-procedure` memory).

- [ ] **Step 1:** Rotate persistence + anchor `START_CHAIN_FROM` at tip + split the funds UTxO (fresh-run reset procedure).
- [ ] **Step 2:** Full run: `NETWORK=preprod HYDRA_BIN_TAG=master-6e2754c ./hydra-l2-flow/run-hydra-e2e.sh all` with `DRIFT_GUARD=999999 SETTLE_SKIP_RESTART=1` (no restarts — windows are now drift-proof, restarts stay disabled to avoid deposit re-apply phantoms).
- [ ] **Step 3:** Success criteria:
  - **11/11** L2 escrow ops `TxValid` (authorize-withdrawal included) with zero `OutsideValidityIntervalUTxO` in the harness log;
  - burn-phantom reports `phantom=0` (or burns once, pre-Close only);
  - Close observed (`HeadIsClosed`), Fanout confirmed on Blockfrost with `valid_contract: true`;
  - `grep -c OutsideValidityIntervalUTxO <run log>` → 0.
- [ ] **Step 4:** Update `hydra-l2-flow/evidence/EVIDENCE.md` (harness does this) and record the outcome in the session memory.

---

## Self-Review

- **Spec coverage:** root cause (Date.now anchoring) → Tasks 2–5; doomed-submit churn → Task 5 deferral; harness fixed-cap waits → Task 6; proof → Task 7. The drift itself is upstream hydra behavior — out of scope by design; windows become drift-immune instead.
- **Placeholders:** Task 5 Step 3's per-spec test bodies and Task 6 Step 2 are deliberately parameterized on per-file context that varies across six files/specs; the transformation and assertions are fully specified. No TBDs.
- **Type consistency:** `HydraHeadClock.chainTimeMs` (Task 2) → `getHeadClock()` (Task 3) → structural `{ chainTimeMs }` consumption (Task 4) → `resolveHydraL2WindowOptions`/`headClockBehindCooldownMs` names match across Tasks 4–5. ✓
- **Mesh isolation:** all `src/` edits are type-only w.r.t. mesh; V2 service edits stay in `packages/payment-source-v2`. ✓
