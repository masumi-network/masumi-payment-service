/**
 * L2 TPS / latency benchmark for an OPEN Hydra head (Milestone 3 evidence).
 *
 * Two modes, both over plain agent-to-agent ADA payments (no Plutus, no
 * deposits/increments, no restarts — deliberately avoids every known-flaky
 * code path):
 *
 *   saturation (default) — pre-build and pre-sign K independent ping-pong
 *     payment chains (alice-funds ⇄ bob-funds, fee 0, full-amount forward),
 *     then blast all of them over one WebSocket and count TxValid /
 *     SnapshotConfirmed per second. All submission happens on node1's socket
 *     so per-chain ordering is guaranteed. Latency numbers from this mode are
 *     reported but labeled "under saturation" — quote the latency-mode
 *     numbers for the <500ms claim, not these.
 *
 *   latency — ONE chain, strictly sequential: submit a payment, wait for it
 *     to appear in a multi-signed snapshot, record the round-trip, submit the
 *     next. Alice's txs go to node1, bob's replies to node2 (if reachable),
 *     which is exactly what two agents paying each other experience.
 *
 * Preconditions: head is OPEN, alice-funds holds an in-head UTxO with enough
 * ADA for --chains seeds (~2 ADA minimum each). Open the head with the
 * existing harness first (hydra-native.sh / 00-open-head.mts). bob-funds only
 * needs its signing key — it receives before it ever spends.
 *
 * Run (from repo root):
 *   pnpm exec tsx hydra-l2-flow/bench-l2-tps.mts --mode saturation --chains 10 --hops 50
 *   pnpm exec tsx hydra-l2-flow/bench-l2-tps.mts --mode latency --hops 100
 *
 * Flags: --node http://127.0.0.1:4001  --node2 http://127.0.0.1:4002
 *        --out <dir>  --timeout-sec 600  --demo-dir <hydra/demo checkout>
 *
 * Evidence lands in hydra-l2-flow/evidence/bench/<timestamp>/ as result.json,
 * SUMMARY.md and events.ndjson.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, arch, platform, totalmem } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import { MeshTxBuilder, MeshWallet, resolveTxHash } from '@meshsdk/core';

const { values: args } = parseArgs({
	options: {
		mode: { type: 'string', default: 'saturation' },
		chains: { type: 'string', default: '10' },
		hops: { type: 'string', default: '50' },
		node: { type: 'string', default: 'http://127.0.0.1:4001' },
		node2: { type: 'string', default: 'http://127.0.0.1:4002' },
		window: { type: 'string', default: '0' },
		sk1: { type: 'string' },
		sk2: { type: 'string' },
		out: { type: 'string' },
		'timeout-sec': { type: 'string', default: '600' },
		'demo-dir': { type: 'string' },
		help: { type: 'boolean', default: false },
	},
});
if (args.help || (args.mode !== 'saturation' && args.mode !== 'latency')) {
	console.log(
		'usage: bench-l2-tps.mts [--mode saturation|latency] [--chains K] [--hops M]\n' +
			'       [--node URL] [--node2 URL] [--out DIR] [--timeout-sec N] [--demo-dir PATH]',
	);
	process.exit(args.help ? 0 : 2);
}
const MODE = args.mode as 'saturation' | 'latency';
/** Max unconfirmed txs in flight during saturation; 0 = unbounded blast. */
const WINDOW = Math.max(0, Number(args.window));
const CHAINS = MODE === 'latency' ? 1 : Math.max(1, Number(args.chains));
const HOPS = Math.max(1, Number(args.hops));
const TIMEOUT_MS = Number(args['timeout-sec']) * 1000;
const IDLE_MS = 30_000;
const DEMO_DIR = args['demo-dir'] ?? join(process.cwd(), '..', 'hydra', 'demo');
const MAX_SEED_LOVELACE = 20_000_000n;
const MIN_SEED_LOVELACE = 2_000_000n;

const startedAt = new Date();
const OUT_DIR =
	args.out ?? join(process.cwd(), 'hydra-l2-flow', 'evidence', 'bench', startedAt.toISOString().replace(/[:.]/g, '-'));

function log(m: string) {
	console.log(`[bench] ${new Date().toISOString().slice(11, 19)} ${m}`);
}

function loadCliWallet(skFile: string): MeshWallet {
	const envelope = JSON.parse(readFileSync(skFile, 'utf-8')) as { cborHex: string };
	return new MeshWallet({ networkId: 0, key: { type: 'cli', payment: envelope.cborHex } });
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return NaN;
	const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[Math.max(0, idx)];
}

type BenchTx = { txId: string; signedHex: string; chain: number; hop: number; signer: 'alice' | 'bob' };
type TxTiming = { sent?: number; valid?: number; confirmed?: number };

const timings = new Map<string, TxTiming>();
const events: string[] = [];
function recordEvent(kind: string, txId: string, t: number) {
	events.push(JSON.stringify({ t: Math.round(t * 1000) / 1000, kind, txId }));
}

/** Pull a tx id out of a snapshot's confirmed list entry, whatever its shape. */
function confirmedEntryTxId(entry: unknown): string | undefined {
	if (typeof entry === 'string') return entry.toLowerCase();
	if (entry && typeof entry === 'object') {
		const record = entry as { txId?: string; id?: string; cborHex?: string };
		if (record.txId) return record.txId.toLowerCase();
		if (record.id) return record.id.toLowerCase();
		if (record.cborHex) return String(resolveTxHash(record.cborHex)).toLowerCase();
	}
	return undefined;
}

type ListenerState = {
	hydraNodeVersion?: string;
	headStatus?: string;
	validCount: number;
	confirmedCount: number;
	invalidCount: number;
	snapshotCount: number;
	lastProgressAt: number;
	invalidReasons: string[];
};

function attachListener(socket: WebSocket, state: ListenerState, wanted: Set<string>) {
	socket.on('message', (raw: Buffer) => {
		const now = performance.now();
		let frame: Record<string, unknown>;
		try {
			frame = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
		} catch {
			return;
		}
		const tag = frame.tag as string | undefined;
		if (tag === 'Greetings') {
			state.hydraNodeVersion = frame.hydraNodeVersion as string | undefined;
			state.headStatus = frame.headStatus as string | undefined;
			return;
		}
		if (tag === 'TxValid') {
			const tx = frame.transaction as { txId?: string; cborHex?: string } | undefined;
			const txId = ((frame.transactionId as string | undefined) ?? tx?.txId)?.toLowerCase();
			if (txId && wanted.has(txId)) {
				const timing = timings.get(txId);
				if (timing && timing.valid === undefined) {
					timing.valid = now;
					state.validCount += 1;
					state.lastProgressAt = now;
					recordEvent('valid', txId, now);
				}
			}
			return;
		}
		if (tag === 'TxInvalid') {
			const tx = frame.transaction as { txId?: string } | undefined;
			const txId = ((frame.transactionId as string | undefined) ?? tx?.txId)?.toLowerCase();
			if (txId && wanted.has(txId)) {
				state.invalidCount += 1;
				state.lastProgressAt = now;
				const reason = (frame.validationError as { reason?: string } | undefined)?.reason ?? 'no reason given';
				state.invalidReasons.push(`${txId.slice(0, 12)}…: ${reason}`);
				recordEvent('invalid', txId, now);
			}
			return;
		}
		if (tag === 'SnapshotConfirmed') {
			const snapshot = frame.snapshot as { confirmed?: unknown[]; confirmedTransactions?: unknown[] } | undefined;
			const entries = snapshot?.confirmed ?? snapshot?.confirmedTransactions ?? [];
			state.snapshotCount += 1;
			for (const entry of entries) {
				const txId = confirmedEntryTxId(entry);
				if (!txId || !wanted.has(txId)) continue;
				const timing = timings.get(txId);
				if (timing && timing.confirmed === undefined) {
					timing.confirmed = now;
					state.confirmedCount += 1;
					state.lastProgressAt = now;
					recordEvent('confirmed', txId, now);
				}
			}
		}
	});
}

function openSocket(httpUrl: string): Promise<WebSocket> {
	const wsUrl = httpUrl.replace('http://', 'ws://').replace('https://', 'wss://');
	const socket = new WebSocket(`${wsUrl}?history=no`);
	return new Promise((resolve, reject) => {
		socket.on('open', () => resolve(socket));
		socket.on('error', (e: Error) => reject(new Error(`websocket ${wsUrl}: ${e.message}`)));
	});
}

type HeadUtxoEntry = { address: string; value: { lovelace: number } };

async function fetchHeadUtxos(httpUrl: string): Promise<Record<string, HeadUtxoEntry>> {
	const response = await fetch(`${httpUrl}/snapshot/utxo`);
	if (!response.ok) throw new Error(`GET ${httpUrl}/snapshot/utxo failed with ${response.status}`);
	return (await response.json()) as Record<string, HeadUtxoEntry>;
}

function sendNewTx(socket: WebSocket, tx: BenchTx) {
	const now = performance.now();
	timings.set(tx.txId, { ...timings.get(tx.txId), sent: now });
	recordEvent('sent', tx.txId, now);
	socket.send(
		JSON.stringify({
			tag: 'NewTx',
			transaction: { type: 'Tx ConwayEra', description: '', cborHex: tx.signedHex },
		}),
	);
}

async function main() {
	// ---- wallets & node ------------------------------------------------------
	// Default: devnet demo keys. Preprod: pass --sk1/--sk2 (purchasing/selling).
	const credentialsDir = join(DEMO_DIR, 'devnet', 'credentials');
	const alice = loadCliWallet(args.sk1 ?? join(credentialsDir, 'alice-funds.sk'));
	const bob = loadCliWallet(args.sk2 ?? join(credentialsDir, 'bob-funds.sk'));
	await (alice as unknown as { init?: () => Promise<void> }).init?.();
	await (bob as unknown as { init?: () => Promise<void> }).init?.();
	// The devnet -funds keys were turned into ENTERPRISE addresses by
	// cardano-cli; MeshWallet's default change address is the base address
	// (dummy stake part) which holds nothing.
	const enterpriseAddr = async (wallet: MeshWallet) =>
		wallet.getAddresses().enterpriseAddressBech32 ?? (await wallet.getChangeAddress());
	const aliceAddr = await enterpriseAddr(alice);
	const bobAddr = await enterpriseAddr(bob);
	log(`alice ${aliceAddr}`);
	log(`bob   ${bobAddr}`);

	// Listener socket comes up BEFORE anything is submitted: on this devnet a
	// snapshot confirms in ~100ms, faster than any listener attached afterwards.
	const pumpSocket = await openSocket(args.node as string);
	const wanted = new Set<string>();
	const state: ListenerState = {
		validCount: 0,
		confirmedCount: 0,
		invalidCount: 0,
		snapshotCount: 0,
		lastProgressAt: performance.now(),
		invalidReasons: [],
	};
	attachListener(pumpSocket, state, wanted);
	const greetDeadline = performance.now() + 5000;
	while (state.headStatus === undefined && performance.now() < greetDeadline) {
		await new Promise((r) => setTimeout(r, 100));
	}
	if (state.headStatus !== 'Open') {
		throw new Error(
			`head status is ${state.headStatus ?? 'unknown'}, expected Open — open it with 00-open-head.mts first`,
		);
	}
	log(`connected to ${args.node} (hydra-node ${state.hydraNodeVersion ?? '?'}), head is Open`);
	let headParticipants: number | null = null;
	try {
		const headState = (await (await fetch(`${args.node}/head`)).json()) as Record<string, unknown>;
		const findParties = (value: unknown): number | null => {
			if (Array.isArray(value)) {
				for (const item of value) {
					const found = findParties(item);
					if (found !== null) return found;
				}
				return null;
			}
			if (value && typeof value === 'object') {
				const record = value as Record<string, unknown>;
				if (Array.isArray(record.parties)) return record.parties.length;
				for (const key of Object.keys(record)) {
					const found = findParties(record[key]);
					if (found !== null) return found;
				}
			}
			return null;
		};
		headParticipants = findParties(headState);
	} catch {
		/* party count stays unknown */
	}

	const headUtxos = await fetchHeadUtxos(args.node as string);
	const aliceEntries = Object.entries(headUtxos)
		.filter(([, out]) => out.address === aliceAddr)
		.sort((a, b) => b[1].value.lovelace - a[1].value.lovelace);
	if (aliceEntries.length === 0) {
		throw new Error(
			`alice-funds has no UTxO in the head at ${args.node} — is the head funded? ` +
				'(00-open-head.mts commits it; deposits take ~2min to finalize on the devnet)',
		);
	}
	// Consume ALL of alice's in-head UTxOs so repeated runs re-consolidate the
	// fragments earlier runs leave behind.
	const available = aliceEntries.reduce((sum, [, out]) => sum + BigInt(out.value.lovelace), 0n);
	let seedLovelace = (available * 9n) / 10n / BigInt(CHAINS);
	if (seedLovelace > MAX_SEED_LOVELACE) seedLovelace = MAX_SEED_LOVELACE;
	if (seedLovelace < MIN_SEED_LOVELACE) {
		throw new Error(
			`alice-funds only holds ${available} lovelace in-head; not enough for ${CHAINS} chains ` +
				`of ≥${MIN_SEED_LOVELACE} — lower --chains or fund the head.`,
		);
	}
	log(`funding: ${aliceEntries.length} alice UTxO(s), ${available} lovelace total`);

	// ---- split phase (untimed): one tx, CHAINS seed outputs ------------------
	const splitBuilder = new MeshTxBuilder({ isHydra: true });
	for (const [ref, out] of aliceEntries) {
		const [hash, indexStr] = ref.split('#');
		// scriptSize 0 is required: without it mesh marks the input incomplete and
		// demands a fetcher (which cannot serve not-yet-submitted chain outputs).
		splitBuilder.txIn(
			hash,
			Number(indexStr),
			[{ unit: 'lovelace', quantity: String(out.value.lovelace) }],
			aliceAddr,
			0,
		);
	}
	for (let k = 0; k < CHAINS; k++) {
		splitBuilder.txOut(aliceAddr, [{ unit: 'lovelace', quantity: seedLovelace.toString() }]);
	}
	await splitBuilder.setFee('0').changeAddress(aliceAddr).complete();
	const splitSigned = await alice.signTx(splitBuilder.txHex);
	const splitTxId = String(resolveTxHash(splitSigned)).toLowerCase();
	log(`split tx ${splitTxId.slice(0, 16)}… (${CHAINS} × ${seedLovelace} lovelace), submitting…`);
	wanted.add(splitTxId);
	sendNewTx(pumpSocket, { txId: splitTxId, signedHex: splitSigned, chain: -1, hop: -1, signer: 'alice' });
	const splitDeadline = performance.now() + 60_000;
	while (timings.get(splitTxId)?.confirmed === undefined) {
		if (state.invalidReasons.length > 0) throw new Error(`split tx rejected: ${state.invalidReasons[0]}`);
		if (performance.now() > splitDeadline) throw new Error('split tx was not confirmed in a snapshot within 60s');
		await new Promise((r) => setTimeout(r, 50));
	}
	log('split confirmed');
	wanted.delete(splitTxId);
	state.validCount = 0;
	state.confirmedCount = 0;
	state.invalidCount = 0;
	state.snapshotCount = 0;
	state.invalidReasons = [];

	// ---- prebuild phase (untimed): sign every hop of every chain -------------
	const prebuildStart = performance.now();
	const chains: BenchTx[][] = [];
	for (let k = 0; k < CHAINS; k++) {
		const chain: BenchTx[] = [];
		let prevTxId = splitTxId;
		let prevIndex = k;
		for (let hop = 0; hop < HOPS; hop++) {
			const fromAlice = hop % 2 === 0;
			const owner = fromAlice ? aliceAddr : bobAddr;
			const recipient = fromAlice ? bobAddr : aliceAddr;
			const builder = new MeshTxBuilder({ isHydra: true });
			builder.txIn(prevTxId, prevIndex, [{ unit: 'lovelace', quantity: seedLovelace.toString() }], owner, 0);
			builder.txOut(recipient, [{ unit: 'lovelace', quantity: seedLovelace.toString() }]);
			await builder.setFee('0').changeAddress(recipient).complete();
			const signedHex = await (fromAlice ? alice : bob).signTx(builder.txHex);
			const txId = String(resolveTxHash(signedHex)).toLowerCase();
			chain.push({ txId, signedHex, chain: k, hop, signer: fromAlice ? 'alice' : 'bob' });
			prevTxId = txId;
			prevIndex = 0;
		}
		chains.push(chain);
		if ((k + 1) % 5 === 0 || k === CHAINS - 1) log(`prebuilt chain ${k + 1}/${CHAINS}`);
	}
	const totalTxs = CHAINS * HOPS;
	log(`prebuilt+signed ${totalTxs} txs in ${((performance.now() - prebuildStart) / 1000).toFixed(1)}s`);

	// ---- timed phase ---------------------------------------------------------
	for (const tx of chains.flat()) wanted.add(tx.txId);
	let bobSocket: WebSocket | null = null;
	if (MODE === 'latency') {
		try {
			bobSocket = await openSocket(args.node2 as string);
			log(`latency mode: bob submits via ${args.node2}`);
		} catch {
			log(`node2 (${args.node2}) unreachable — bob will submit via node1 too`);
		}
	}

	state.lastProgressAt = performance.now();
	const benchStart = performance.now();
	const deadline = benchStart + TIMEOUT_MS;

	if (MODE === 'saturation') {
		// Hop-major over all chains: per-chain order preserved (single socket),
		// load interleaved across chains.
		let sentCount = 0;
		let abortedOnDeadline = false;
		outer: for (let hop = 0; hop < HOPS; hop++) {
			for (const chain of chains) {
				// Stop submitting once the hard timeout passes. Without this the
				// backpressure wait below would break out on the deadline and then
				// flood every remaining tx anyway — exactly the stalled-node case
				// --window exists to contain.
				if (performance.now() > deadline) {
					log(`hard timeout reached after ${sentCount}/${totalTxs} submitted — stopping`);
					abortedOnDeadline = true;
					break outer;
				}
				// A deep unconfirmed backlog starves snapshot rounds (ReqTx floods the
				// etcd message pipeline), so a bounded window measures SUSTAINED
				// confirmed TPS instead of burst-then-drain.
				while (WINDOW > 0 && sentCount - state.confirmedCount - state.invalidCount >= WINDOW) {
					if (performance.now() > deadline) break;
					await new Promise((r) => setTimeout(r, 2));
				}
				sendNewTx(pumpSocket, chain[hop]);
				sentCount += 1;
				if (sentCount % 200 === 0) {
					await new Promise((r) => setImmediate(r));
					while (pumpSocket.bufferedAmount > 4 * 1024 * 1024) {
						await new Promise((r) => setTimeout(r, 10));
					}
				}
			}
		}
		log(
			abortedOnDeadline
				? `${sentCount}/${totalTxs} txs submitted before timeout; waiting for snapshots…`
				: `all ${sentCount} txs submitted; waiting for snapshots…`,
		);
		// Wait against what was actually sent, not the full plan — otherwise a
		// deadline-aborted run spins until the idle timeout for txs never sent.
		while (state.confirmedCount + state.invalidCount < sentCount) {
			const now = performance.now();
			if (now > deadline) {
				log('hard timeout reached');
				break;
			}
			if (now - state.lastProgressAt > IDLE_MS) {
				log(`no progress for ${IDLE_MS / 1000}s — stopping`);
				break;
			}
			await new Promise((r) => setTimeout(r, 200));
		}
	} else {
		const chain = chains[0];
		for (const tx of chain) {
			if (performance.now() > deadline) {
				log('hard timeout reached');
				break;
			}
			const socket = tx.signer === 'bob' && bobSocket ? bobSocket : pumpSocket;
			sendNewTx(socket, tx);
			const sentAt = performance.now();
			// Sequential round-trip: wait for THIS tx's snapshot before the next hop.
			for (;;) {
				const timing = timings.get(tx.txId);
				if (timing?.confirmed !== undefined) break;
				if (state.invalidReasons.length > 0) break;
				if (performance.now() - sentAt > 30_000) {
					log(`tx ${tx.txId.slice(0, 12)}… not confirmed after 30s — aborting run`);
					state.lastProgressAt = 0;
					break;
				}
				await new Promise((r) => setTimeout(r, 2));
			}
			if (timings.get(tx.txId)?.confirmed === undefined) break;
			if ((tx.hop + 1) % 25 === 0) log(`latency: ${tx.hop + 1}/${HOPS} round-trips done`);
		}
	}
	const benchEnd = performance.now();

	// ---- report --------------------------------------------------------------
	const all = chains.flat().map((tx) => ({ tx, timing: timings.get(tx.txId) }));
	const validLatencies = all
		.filter((e) => e.timing?.sent !== undefined && e.timing?.valid !== undefined)
		.map((e) => e.timing!.valid! - e.timing!.sent!)
		.sort((a, b) => a - b);
	const confirmedLatencies = all
		.filter((e) => e.timing?.sent !== undefined && e.timing?.confirmed !== undefined)
		.map((e) => e.timing!.confirmed! - e.timing!.sent!)
		.sort((a, b) => a - b);
	const sentTimes = all.filter((e) => e.timing?.sent !== undefined).map((e) => e.timing!.sent!);
	const confirmedTimes = all.filter((e) => e.timing?.confirmed !== undefined).map((e) => e.timing!.confirmed!);
	const validTimes = all.filter((e) => e.timing?.valid !== undefined).map((e) => e.timing!.valid!);
	const firstSent = Math.min(...sentTimes);
	const wallValidSec = validTimes.length > 0 ? (Math.max(...validTimes) - firstSent) / 1000 : NaN;
	const wallConfirmedSec = confirmedTimes.length > 0 ? (Math.max(...confirmedTimes) - firstSent) / 1000 : NaN;

	const result = {
		mode: MODE,
		startedAt: startedAt.toISOString(),
		config: {
			chains: CHAINS,
			hops: HOPS,
			totalTxs,
			window: WINDOW || 'unbounded',
			seedLovelace: seedLovelace.toString(),
			node: args.node,
			node2: MODE === 'latency' ? args.node2 : null,
			txShape: '1-in/1-out ada transfer, fee 0, no scripts',
		},
		environment: {
			hydraNodeVersion: state.hydraNodeVersion ?? 'unknown',
			headParticipants: headParticipants ?? 'unknown',
			hardware: `${cpus()[0]?.model ?? 'unknown'} (${cpus().length} cores, ${Math.round(totalmem() / 2 ** 30)} GB)`,
			os: `${platform()} ${arch()}`,
			nodeJs: process.version,
		},
		results: {
			sent: sentTimes.length,
			valid: state.validCount,
			confirmed: state.confirmedCount,
			invalid: state.invalidCount,
			snapshots: state.snapshotCount,
			txsPerSnapshot: state.snapshotCount > 0 ? +(state.confirmedCount / state.snapshotCount).toFixed(1) : null,
			wallClockSec: +((benchEnd - benchStart) / 1000).toFixed(2),
			tpsValid: wallValidSec > 0 ? +(state.validCount / wallValidSec).toFixed(1) : null,
			tpsConfirmed: wallConfirmedSec > 0 ? +(state.confirmedCount / wallConfirmedSec).toFixed(1) : null,
			latencyMsToValid: {
				p50: +percentile(validLatencies, 50).toFixed(1),
				p95: +percentile(validLatencies, 95).toFixed(1),
				p99: +percentile(validLatencies, 99).toFixed(1),
			},
			latencyMsToConfirmed: {
				p50: +percentile(confirmedLatencies, 50).toFixed(1),
				p95: +percentile(confirmedLatencies, 95).toFixed(1),
				p99: +percentile(confirmedLatencies, 99).toFixed(1),
			},
			invalidReasons: state.invalidReasons.slice(0, 20),
		},
	};

	mkdirSync(OUT_DIR, { recursive: true });
	writeFileSync(join(OUT_DIR, 'result.json'), JSON.stringify(result, null, 2));
	writeFileSync(join(OUT_DIR, 'events.ndjson'), events.join('\n') + '\n');
	const latencyCaveat =
		MODE === 'saturation'
			? `\n> Latency here is measured **under saturation**, with ${WINDOW} transactions in\n` +
				"> flight. That queue sets the wait, not the head: by Little's Law it is about\n" +
				'> window / TPS. Use a `--mode latency` run for the per-payment finality figure.\n'
			: '\n> Sequential round-trips: each payment waits for multi-signed snapshot\n' +
				'> confirmation before the next is sent, so this is per-payment finality latency.\n';
	writeFileSync(
		join(OUT_DIR, 'SUMMARY.md'),
		`# Hydra L2 benchmark: ${MODE}, ${startedAt.toISOString()}\n\n` +
			`| metric | value |\n|---|---|\n` +
			`| transactions sent / valid / confirmed | ${result.results.sent} / ${result.results.valid} / ${result.results.confirmed} |\n` +
			`| **TPS (snapshot-confirmed)** | **${result.results.tpsConfirmed ?? 'n/a'}** |\n` +
			`| TPS (node-validated) | ${result.results.tpsValid ?? 'n/a'} |\n` +
			`| latency to confirmed p50 / p95 / p99 (ms) | ${result.results.latencyMsToConfirmed.p50} / ${result.results.latencyMsToConfirmed.p95} / ${result.results.latencyMsToConfirmed.p99} |\n` +
			`| latency to valid p50 / p95 / p99 (ms) | ${result.results.latencyMsToValid.p50} / ${result.results.latencyMsToValid.p95} / ${result.results.latencyMsToValid.p99} |\n` +
			`| snapshots (avg txs each) | ${result.results.snapshots} (${result.results.txsPerSnapshot ?? 'n/a'}) |\n` +
			`| invalid | ${result.results.invalid} |\n` +
			`| config | ${CHAINS} chains × ${HOPS} hops, window ${result.config.window}, ${result.config.txShape} |\n` +
			`| hydra-node | ${result.environment.hydraNodeVersion}, ${result.environment.headParticipants}-party head |\n` +
			`| hardware | ${result.environment.hardware}, ${result.environment.os} |\n` +
			latencyCaveat,
	);
	log(`evidence written to ${OUT_DIR}`);
	log(
		`TPS confirmed=${result.results.tpsConfirmed} valid=${result.results.tpsValid} ` +
			`| confirmed ${state.confirmedCount}/${totalTxs} | invalid ${state.invalidCount}`,
	);
	if (state.invalidReasons.length > 0) {
		log(`first invalid reasons:\n  ${state.invalidReasons.slice(0, 5).join('\n  ')}`);
	}

	pumpSocket.close();
	bobSocket?.close();
	const complete = state.confirmedCount === totalTxs;
	process.exit(complete ? 0 : 3);
}

main().catch((e) => {
	console.error('[bench] fatal:', e instanceof Error ? e.message : e);
	process.exit(4);
});
