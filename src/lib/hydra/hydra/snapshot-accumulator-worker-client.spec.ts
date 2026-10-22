import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { createWorkerAccumulatorComputer } = await import('./snapshot-accumulator-worker-client');
const { computeHydraAccumulatorHash } = await import('./snapshot-accumulator');
const { HydraProtocolError, HydraTransportError } = await import('./errors');

const OUTPUTS = ['d8799f', 'd87a80'];
const CHILD_EXIT_TIMEOUT_MS = 30_000;
const CHILD_TEST_TIMEOUT_MS = 35_000;

/** Stands in for a worker thread: records what is posted, and replies on demand. */
class FakeWorker extends EventEmitter {
	readonly posted: Array<{ id: number; outputs: string[] }> = [];
	terminated = false;
	postMessage(message: { id: number; outputs: string[] }) {
		this.posted.push(message);
	}
	unref() {}
	async terminate() {
		this.terminated = true;
		return 0;
	}
}

function fakeWorkers() {
	const workers: FakeWorker[] = [];
	const create = () => {
		const worker = new FakeWorker();
		workers.push(worker);
		return worker as unknown as Worker;
	};
	return { workers, create };
}

describe('createWorkerAccumulatorComputer', () => {
	afterEach(() => {
		jest.useRealTimers();
	});

	it('answers with the hash the worker computed', async () => {
		const { workers, create } = fakeWorkers();
		const compute = createWorkerAccumulatorComputer(create);
		const result = compute(OUTPUTS);
		const [{ id, outputs }] = workers[0].posted;
		expect(outputs).toEqual(OUTPUTS);
		workers[0].emit('message', { id, hash: 'ab'.repeat(32) });
		await expect(result).resolves.toBe('ab'.repeat(32));
	});

	it('raises an error the worker reports as a protocol error', async () => {
		const { workers, create } = fakeWorkers();
		const compute = createWorkerAccumulatorComputer(create);
		const result = compute(OUTPUTS);
		workers[0].emit('message', { id: workers[0].posted[0].id, error: 'exceeded the 4095-output KZG limit' });
		await expect(result).rejects.toThrow(HydraProtocolError);
	});

	// A worker entry missing from the build would otherwise fail every replay of
	// every head, for good.
	it('falls back to the event loop when the worker cannot load', async () => {
		const { workers, create } = fakeWorkers();
		const compute = createWorkerAccumulatorComputer(create);
		const result = compute(OUTPUTS);
		workers[0].emit('error', new Error('Cannot find module dist/hydra-accumulator-worker.js'));
		await expect(result).resolves.toBe(computeHydraAccumulatorHash(OUTPUTS));
		// And stops trying: later requests are answered synchronously.
		expect(compute(OUTPUTS)).toBe(computeHydraAccumulatorHash(OUTPUTS));
		expect(workers).toHaveLength(1);
	});

	// One maximum-size snapshot running a worker out of memory is that worker's
	// failure, not proof the entry can never load: falling back for good would
	// bring back the starvation the worker exists to prevent.
	it('replaces a worker that fails after it loaded instead of falling back', async () => {
		const { workers, create } = fakeWorkers();
		const compute = createWorkerAccumulatorComputer(create);
		const result = compute(OUTPUTS);
		workers[0].emit('message', { ready: true });
		workers[0].emit('error', new Error('ERR_WORKER_OUT_OF_MEMORY'));
		await expect(result).rejects.toThrow(HydraTransportError);

		const next = compute(OUTPUTS);
		expect(next).toBeInstanceOf(Promise);
		expect(workers).toHaveLength(2);
		// Answered, so no real watchdog outlives this file: left pending, it fired
		// 120 s later into whichever suite the jest worker ran next, and failed it.
		workers[1].emit('message', { id: workers[1].posted[0].id, hash: '22'.repeat(32) });
		await expect(next).resolves.toBe('22'.repeat(32));
	});

	it('falls back to the event loop when the worker cannot be constructed', () => {
		const compute = createWorkerAccumulatorComputer(() => {
			throw new Error('no worker threads here');
		});
		expect(compute(OUTPUTS)).toBe(computeHydraAccumulatorHash(OUTPUTS));
	});

	it('fails only its own requests when a worker exits, and starts a new one', async () => {
		const { workers, create } = fakeWorkers();
		const compute = createWorkerAccumulatorComputer(create);
		const first = compute(OUTPUTS);
		workers[0].emit('message', { id: workers[0].posted[0].id, hash: '00'.repeat(32) });
		await first;
		const lost = compute(OUTPUTS);
		workers[0].emit('exit', 1);
		await expect(lost).rejects.toThrow(HydraTransportError);

		const next = compute(OUTPUTS);
		expect(workers).toHaveLength(2);
		// A late exit from the retired worker is not the new worker's business.
		workers[0].emit('exit', 1);
		workers[1].emit('message', { id: workers[1].posted[0].id, hash: '11'.repeat(32) });
		await expect(next).resolves.toBe('11'.repeat(32));
	});

	// The worker answers in order. A request behind other heads' snapshots is
	// waiting, not stuck, and timing it from when it was sent failed every head.
	it('times a worker from its last answer, not from when a request was sent', async () => {
		jest.useFakeTimers();
		const { workers, create } = fakeWorkers();
		const compute = createWorkerAccumulatorComputer(create);
		const first = compute(OUTPUTS);
		const second = compute(OUTPUTS);
		jest.advanceTimersByTime(100_000);
		workers[0].emit('message', { id: workers[0].posted[0].id, hash: '00'.repeat(32) });
		await expect(first).resolves.toBe('00'.repeat(32));
		jest.advanceTimersByTime(100_000);
		workers[0].emit('message', { id: workers[0].posted[1].id, hash: '11'.repeat(32) });
		await expect(second).resolves.toBe('11'.repeat(32));
		expect(workers[0].terminated).toBe(false);
	});

	it('retires a worker that does not answer in time', async () => {
		jest.useFakeTimers();
		const { workers, create } = fakeWorkers();
		const compute = createWorkerAccumulatorComputer(create);
		const result = compute(OUTPUTS);
		const assertion = expect(result).rejects.toThrow(HydraTransportError);
		jest.advanceTimersByTime(120_000);
		await assertion;
		expect(workers[0].terminated).toBe(true);
	});

	// Run the actual factory body without importing application configuration
	// into the child. Its completed worker must not keep that process alive.
	it(
		'lets a process exit naturally after its real worker becomes idle',
		() => {
			const source = readFileSync(new URL('./snapshot-accumulator-worker-client.ts', import.meta.url), 'utf8');
			const factoryDeclaration = source.slice(source.indexOf('export function createWorkerAccumulatorComputer('));
			const factoryBody = transpileModule(factoryDeclaration, {
				compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ESNext },
			}).outputText.replace(/^export /, '');
			const child = spawnSync(
				process.execPath,
				[
					'-e',
					`const { Worker } = require('node:worker_threads');
				const ACCUMULATOR_WORKER_TIMEOUT_MS = 120_000;
				const keepAlive = setTimeout(() => { throw new Error('worker did not answer'); }, ${CHILD_TEST_TIMEOUT_MS});
				const compute = (${factoryBody})(() => new Worker(
					\`const { parentPort } = require('node:worker_threads');
					parentPort.postMessage({ ready: true });
					parentPort.on('message', ({ id, outputs }) => parentPort.postMessage({ id, hash: outputs.join('') }));\`,
					{ eval: true },
				));
				compute(['completed']).then((hash) => {
					if (hash !== 'completed') throw new Error('worker returned an unexpected result');
					process.stdout.write(hash);
					clearTimeout(keepAlive);
				});`,
				],
				{ encoding: 'utf8', timeout: CHILD_EXIT_TIMEOUT_MS, env: { ...process.env, NODE_OPTIONS: '' } },
			);
			expect(child.stdout).toBe('completed');
			expect(child.error).toBeUndefined();
			expect(child.status).toBe(0);
		},
		CHILD_TEST_TIMEOUT_MS,
	);

	// The real thread plumbing, with a stand-in worker body: the jest runtime
	// cannot load the TypeScript entry itself.
	it('round-trips through a real worker thread', async () => {
		const compute = createWorkerAccumulatorComputer(
			() =>
				new Worker(
					`const { parentPort } = require('node:worker_threads');
					parentPort.postMessage({ ready: true });
					parentPort.on('message', ({ id, outputs }) => parentPort.postMessage({ id, hash: outputs.join('') }));`,
					{ eval: true },
				),
		);
		await expect(compute(OUTPUTS)).resolves.toBe(OUTPUTS.join(''));
		// Starting a thread is a full Node bootstrap; under a loaded full suite
		// that alone outran the 5 s default.
	}, 30_000);
});
