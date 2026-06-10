// Preload registered via NODE_OPTIONS="--require ./jest.preload.cjs" in the
// test scripts. Because `--require` runs in the REAL worker process before Jest
// boots (not inside the per-file Jest VM sandbox), the listener it installs
// survives environment teardown — unlike a handler added in setupFilesAfterEnv,
// which lives on the sandboxed `process` and is gone before the late rejection
// fires.
//
// Why this exists: Mesh SDK's libsodium WASM backend
// (`libsodium-wrappers-sumo` / `libsodium-sumo`) can fire a lazy
// `require('libsodium-sumo')` inside its async ready-continuation AFTER Jest
// tears an environment down, producing a benign:
//
//   ReferenceError: You are trying to `require` a file after the Jest
//   environment has been torn down.
//
// Node would otherwise escalate that to a fatal UnhandledPromiseRejection even
// though every test passed. We swallow ONLY that specific libsodium teardown
// noise and rethrow everything else, so genuine unhandled rejections still fail
// the run (a blanket `--unhandled-rejections=warn` would mask real async faults
// — see the Cursor review on this change).

const GUARD = Symbol.for('masumi.libsodiumUnhandledRejectionGuard');

if (!global[GUARD]) {
	global[GUARD] = true;

	process.on('unhandledRejection', (reason) => {
		const message = typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : '';
		const isLibsodiumTeardownNoise =
			message.includes('after the Jest environment has been torn down') ||
			message.includes('No secure random number generator found');

		if (isLibsodiumTeardownNoise) {
			// Benign: the test already finished; libsodium's late init has nowhere
			// to land. Dropping it keeps the run green without masking real faults.
			return;
		}

		// Preserve Node's fail-fast for genuine unhandled rejections: rethrowing
		// here surfaces as an uncaughtException and exits non-zero, so CI catches
		// real async faults that Jest doesn't tie to a specific failing test.
		throw reason instanceof Error ? reason : new Error(message || 'Unhandled promise rejection during tests');
	});
}
