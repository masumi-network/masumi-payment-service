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
// Node would otherwise escalate that to a fatal UnhandledPromiseRejection or
// uncaught exception even though every test passed. We swallow ONLY that
// specific libsodium teardown noise and rethrow everything else, so genuine
// async faults still fail the run (a blanket `--unhandled-rejections=warn` would
// mask real async faults — see the Cursor review on this change).

const { webcrypto } = require('node:crypto');

const GUARD = Symbol.for('masumi.libsodiumUnhandledRejectionGuard');

const installLibsodiumRandomSource = () => {
	if (!globalThis.self) {
		Object.defineProperty(globalThis, 'self', {
			value: globalThis,
			configurable: true,
		});
	}

	if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== 'function') {
		Object.defineProperty(globalThis, 'crypto', {
			value: webcrypto,
			configurable: true,
		});
	}
};

installLibsodiumRandomSource();

if (!global[GUARD]) {
	global[GUARD] = true;

	const readTextProperty = (value, key) => {
		try {
			const property = Reflect.get(value, key);
			return typeof property === 'string' ? property : '';
		} catch {
			return '';
		}
	};

	const describeReason = (reason) => {
		if (typeof reason === 'string') {
			return reason;
		}

		if (reason && typeof reason === 'object') {
			const errorText = [
				readTextProperty(reason, 'name'),
				readTextProperty(reason, 'message'),
				readTextProperty(reason, 'stack'),
			]
				.filter(Boolean)
				.join('\n');

			if (errorText) {
				return errorText;
			}
		}

		if (reason && typeof reason === 'object') {
			try {
				return JSON.stringify(reason);
			} catch {
				return String(reason);
			}
		}

		return String(reason ?? '');
	};

	const isLibsodiumTeardownNoise = (reason) => {
		const text = describeReason(reason).toLowerCase();
		const mentionsLibsodium =
			text.includes('libsodium') || text.includes('sodium-wrappers') || text.includes('sodium-sumo');
		const isJestTeardownRequire = text.includes('after the jest environment has been torn down');
		const isMissingSecureRandom = text.includes('no secure random number generator found');

		return (mentionsLibsodium && isJestTeardownRequire) || isMissingSecureRandom;
	};

	process.on('unhandledRejection', (reason) => {
		const message = describeReason(reason);

		if (isLibsodiumTeardownNoise(reason)) {
			// Benign: the test already finished; libsodium's late init has nowhere
			// to land. Dropping it keeps the run green without masking real faults.
			return;
		}

		// Preserve Node's fail-fast for genuine unhandled rejections: rethrowing
		// here surfaces as an uncaughtException and exits non-zero, so CI catches
		// real async faults that Jest doesn't tie to a specific failing test.
		throw reason instanceof Error ? reason : new Error(message || 'Unhandled promise rejection during tests');
	});

	const onUncaughtException = (error) => {
		if (isLibsodiumTeardownNoise(error)) {
			return;
		}

		process.removeListener('uncaughtException', onUncaughtException);
		throw error;
	};

	process.on('uncaughtException', onUncaughtException);
}
