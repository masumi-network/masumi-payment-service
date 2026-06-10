// Mesh SDK (`@meshsdk/core` / `@meshsdk/core-cst`) loads `libsodium-wrappers-sumo`,
// whose WASM backend initializes ASYNCHRONOUSLY via a `.ready` promise. Its
// ready continuation performs a lazy `require('libsodium-sumo')` (the
// `useBackupModule` fallback). When that continuation lands AFTER Jest tears the
// environment down, the require throws:
//
//   ReferenceError: You are trying to `require` a file after the Jest
//   environment has been torn down.
//
// Node turns the resulting rejection into a process-killing
// `UnhandledPromiseRejection` (non-zero exit) even though every test PASSED.
//
// Two layers of defense:
//
// (1) Force the init to settle BEFORE tests run, so most continuations fire
//     during the test lifecycle instead of after teardown. Enough on its own
//     for short unit suites.
// (2) A process-level backstop for the residual race the await cannot cover:
//     in long-running e2e flows a fresh crypto op can trigger init mid-test
//     whose continuation only lands after the env is gone (most visibly between
//     sequential e2e files under `maxWorkers: 1`). We swallow ONLY that specific
//     libsodium teardown noise and rethrow everything else, so genuine
//     unhandled rejections still fail the run.
//
// Typed via the ambient declaration in src/libsodium-wrappers-sumo.d.ts.
import sodium from 'libsodium-wrappers-sumo';

// (1) Settle the async WASM init before tests.
beforeAll(async () => {
	await sodium.ready;
});

// (2) Backstop, registered exactly once per process.
const guardKey = Symbol.for('masumi.libsodiumTeardownGuard');
const guardedGlobal = globalThis as typeof globalThis & Record<symbol, boolean>;

if (!guardedGlobal[guardKey]) {
	guardedGlobal[guardKey] = true;

	process.on('unhandledRejection', (reason: unknown) => {
		const message = typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : '';
		const isLibsodiumTeardownNoise =
			message.includes('after the Jest environment has been torn down') ||
			message.includes('No secure random number generator found');
		if (isLibsodiumTeardownNoise) {
			// Benign: the test already finished; libsodium's late init just has
			// nowhere to land. Dropping it keeps the run green.
			return;
		}
		// Preserve Node's default fail-fast for real unhandled rejections.
		throw reason instanceof Error ? reason : new Error(message || 'Unhandled promise rejection during tests');
	});
}
