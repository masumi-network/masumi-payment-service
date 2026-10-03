import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as storage from './secure-storage';

// Execute the real startup effect with controlled API/storage boundaries.
// React rendering and browser persistence are outside this harness.
const source = ts.createSourceFile(
  '_app.tsx',
  readFileSync(new URL('../pages/_app.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let effect: ts.ArrowFunction | undefined;
function findStartup(node: ts.Node) {
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(source) === 'useEffect' &&
    node.arguments[0] &&
    ts.isArrowFunction(node.arguments[0]) &&
    node.arguments[0].getText(source).includes('decryptFromStorage')
  ) {
    effect = node.arguments[0];
  }
  ts.forEachChild(node, findStartup);
}
findStartup(source);
assert.ok(effect, 'API key startup effect must exist');
const effectScript = ts.transpileModule(`(${effect.getText(source)})()`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

interface RestorationOptions {
  savedToken?: string;
  sharedStorage?: { savedToken: string | null };
  replacementTokens?: Record<string, string>;
  isValid?: boolean;
  statusUnavailable?: boolean;
  encryption?: Promise<string>;
  writeFails?: boolean;
}

function startRestoration(options: RestorationOptions = {}) {
  const sharedStorage = options.sharedStorage ?? {
    savedToken: options.savedToken ?? 'original-ciphertext',
  };
  const originalToken = sharedStorage.savedToken;
  const replacementTokens: Record<string, string> = options.replacementTokens ?? {
    'new-ciphertext': 'new-admin',
    'another-tab-ciphertext': 'new-admin',
  };
  let resolve!: (value: string | null) => void;
  let reject!: (error: Error) => void;
  const decryption = new Promise<string | null>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  const authorization: boolean[] = [];
  const health: boolean[] = [];
  const errors: string[] = [];
  const configuredTokens: string[] = [];
  const restoredTokens: string[] = [];
  const encryptedTokens: string[] = [];
  const events: string[] = [];
  const cleanup: () => void = runInNewContext(effectScript, {
    handleApiCall: (call: () => Promise<object>) => call(),
    getHealth: async () => ({}),
    getApiKeyStatus: async () => {
      events.push('validate');
      return options.statusUnavailable ? undefined : { data: { data: {} } };
    },
    decryptFromStorage: (ciphertext: string) =>
      ciphertext === originalToken
        ? decryption
        : Promise.resolve(replacementTokens[ciphertext] ?? null),
    decodeLegacyStoredKey: storage.decodeLegacyStoredKey,
    encryptForStorage: (token: string) => {
      events.push('encrypt');
      encryptedTokens.push(token);
      return options.encryption ?? Promise.resolve('migrated-ciphertext');
    },
    localStorage: {
      getItem: () => sharedStorage.savedToken,
      setItem: (name: string, value: string) => {
        assert.equal(name, 'payment_api_key');
        if (options.writeFails) throw new DOMException('Quota exceeded', 'QuotaExceededError');
        events.push('write');
        sharedStorage.savedToken = value;
      },
      removeItem: () => {
        sharedStorage.savedToken = null;
      },
    },
    apiClient: {
      setConfig: (config: { headers: { token: string } }) => {
        configuredTokens.push(config.headers.token);
      },
    },
    setIsHealthy: (value: boolean) => health.push(value),
    setAuthorized: (value: boolean) => authorization.push(value),
    capabilitiesFromApiKeyStatus: () => (options.isValid === false ? null : { canRead: true }),
    setCapabilities: () => {},
    updateApiKey: (value: string) => restoredTokens.push(value),
    signOut: () => {
      sharedStorage.savedToken = null;
      authorization.push(false);
    },
    toast: { error: (message: string) => errors.push(message) },
  });
  return {
    resolve,
    reject,
    cleanup,
    authorization,
    health,
    errors,
    configuredTokens,
    restoredTokens,
    encryptedTokens,
    events,
    get savedToken() {
      return sharedStorage.savedToken;
    },
    set savedToken(value: string | null) {
      sharedStorage.savedToken = value;
    },
  };
}

const drainTasks = () => new Promise<void>((resolve) => setImmediate(resolve));

test('temporary storage errors preserve the saved ciphertext and report failed restoration', async () => {
  const session = startRestoration();
  await drainTasks();
  session.reject(new Error('Storage temporarily unavailable'));
  await drainTasks();
  assert.equal(session.savedToken, 'original-ciphertext');
  assert.deepEqual(session.authorization, [false]);
  assert.equal(session.errors.length, 1);
  assert.deepEqual(session.configuredTokens, []);
});

test('a stale failed decryption restores the newer token without deleting it', async () => {
  const session = startRestoration();
  await drainTasks();
  session.savedToken = 'new-ciphertext';
  session.resolve(null);
  await drainTasks();
  assert.equal(session.savedToken, 'new-ciphertext');
  assert.deepEqual(session.authorization, [true]);
  assert.deepEqual(session.health, [true]);
  assert.deepEqual(session.restoredTokens, ['new-admin']);
  assert.deepEqual(session.encryptedTokens, []);
  assert.deepEqual(session.errors, []);
});

test('a stale storage error cannot change a newer session', async () => {
  const session = startRestoration();
  await drainTasks();
  session.savedToken = 'new-ciphertext';
  session.reject(new Error('Storage temporarily unavailable'));
  await drainTasks();
  assert.equal(session.savedToken, 'new-ciphertext');
  assert.deepEqual(session.authorization, [true]);
  assert.deepEqual(session.health, [true]);
  assert.deepEqual(session.restoredTokens, ['new-admin']);
  assert.deepEqual(session.encryptedTokens, []);
  assert.deepEqual(session.errors, []);
});

test('cancelled restoration does not apply a decrypted token', async () => {
  const session = startRestoration();
  await drainTasks();
  session.cleanup();
  session.resolve('admin');
  await drainTasks();
  assert.deepEqual(session.configuredTokens, []);
  assert.deepEqual(session.authorization, []);
  assert.deepEqual(session.health, []);
});

test('invalid ciphertext is removed when the captured session is still current', async () => {
  const session = startRestoration();
  await drainTasks();
  session.resolve(null);
  await drainTasks();
  assert.equal(session.savedToken, null);
  assert.deepEqual(session.authorization, [false]);
});

test('valid ciphertext restores authorization and the API token', async () => {
  const session = startRestoration();
  await drainTasks();
  session.resolve('admin');
  await drainTasks();
  assert.equal(session.savedToken, 'original-ciphertext');
  assert.deepEqual(session.configuredTokens, ['admin']);
  assert.deepEqual(session.restoredTokens, ['admin']);
  assert.deepEqual(session.authorization, [true]);
  assert.deepEqual(session.encryptedTokens, []);
});

const legacyToken = Buffer.from('legacy-admin').toString('hex');

test('successful AES decryption takes priority over a legacy hex interpretation', async () => {
  const session = startRestoration({ savedToken: legacyToken });
  await drainTasks();
  session.resolve('aes-admin');
  await drainTasks();
  assert.equal(session.savedToken, legacyToken);
  assert.deepEqual(session.configuredTokens, ['aes-admin']);
  assert.deepEqual(session.restoredTokens, ['aes-admin']);
  assert.deepEqual(session.authorization, [true]);
  assert.deepEqual(session.health, [true]);
  assert.deepEqual(session.encryptedTokens, []);
});

test('a valid legacy session migrates only after backend validation and stays authorized', async () => {
  const session = startRestoration({ savedToken: legacyToken });
  await drainTasks();
  session.resolve(null);
  await drainTasks();
  assert.equal(session.savedToken, 'migrated-ciphertext');
  assert.deepEqual(session.events, ['validate', 'encrypt', 'write']);
  assert.deepEqual(session.encryptedTokens, ['legacy-admin']);
  assert.deepEqual(session.restoredTokens, ['legacy-admin']);
  assert.deepEqual(session.authorization, [true]);
});

test('legacy restoration continues when IndexedDB is temporarily unavailable', async () => {
  const session = startRestoration({ savedToken: legacyToken });
  await drainTasks();
  session.reject(new Error('Storage temporarily unavailable'));
  await drainTasks();
  assert.equal(session.savedToken, 'migrated-ciphertext');
  assert.deepEqual(session.restoredTokens, ['legacy-admin']);
  assert.deepEqual(session.authorization, [true]);
});

test('an invalid legacy key is never migrated or authorized', async () => {
  const session = startRestoration({ savedToken: legacyToken, isValid: false });
  await drainTasks();
  session.resolve(null);
  await drainTasks();
  assert.deepEqual(session.encryptedTokens, []);
  assert.deepEqual(session.restoredTokens, []);
  assert.deepEqual(session.authorization, [false]);
});

test('an unavailable validation API preserves the legacy value for retry', async () => {
  const session = startRestoration({ savedToken: legacyToken, statusUnavailable: true });
  await drainTasks();
  session.resolve(null);
  await drainTasks();
  assert.equal(session.savedToken, legacyToken);
  assert.deepEqual(session.encryptedTokens, []);
  assert.deepEqual(session.authorization, [false]);
});

test('failed migration encryption preserves the validated legacy session', async () => {
  let failEncryption!: (error: Error) => void;
  const encryption = new Promise<string>((_resolve, reject) => {
    failEncryption = reject;
  });
  const session = startRestoration({ savedToken: legacyToken, encryption });
  await drainTasks();
  session.resolve(null);
  await drainTasks();
  failEncryption(new Error('Storage unavailable'));
  await drainTasks();
  assert.equal(session.savedToken, legacyToken);
  assert.deepEqual(session.restoredTokens, ['legacy-admin']);
  assert.deepEqual(session.authorization, [true]);
  assert.equal(session.errors.length, 1);
});

test('failed migration writes preserve the validated legacy session', async () => {
  const session = startRestoration({ savedToken: legacyToken, writeFails: true });
  await drainTasks();
  session.resolve(null);
  await drainTasks();
  assert.equal(session.savedToken, legacyToken);
  assert.deepEqual(session.restoredTokens, ['legacy-admin']);
  assert.deepEqual(session.authorization, [true]);
  assert.equal(session.errors.length, 1);
});

test('a competing tab changing the token during migration cannot be overwritten', async () => {
  let finishEncryption!: (token: string) => void;
  const encryption = new Promise<string>((resolve) => {
    finishEncryption = resolve;
  });
  const session = startRestoration({ savedToken: legacyToken, encryption });
  await drainTasks();
  session.resolve(null);
  await drainTasks();
  session.savedToken = 'another-tab-ciphertext';
  finishEncryption('migrated-ciphertext');
  await drainTasks();
  assert.equal(session.savedToken, 'another-tab-ciphertext');
  assert.deepEqual(session.restoredTokens, ['new-admin']);
  assert.deepEqual(session.authorization, [true]);
  assert.deepEqual(session.health, [true]);
  assert.deepEqual(session.encryptedTokens, ['legacy-admin']);
  assert.deepEqual(session.errors, []);
});

test('sign-out during migration cannot restore the legacy session', async () => {
  let finishEncryption!: (token: string) => void;
  const encryption = new Promise<string>((resolve) => {
    finishEncryption = resolve;
  });
  const session = startRestoration({ savedToken: legacyToken, encryption });
  await drainTasks();
  session.resolve(null);
  await drainTasks();
  session.savedToken = null;
  session.cleanup();
  finishEncryption('migrated-ciphertext');
  await drainTasks();
  assert.equal(session.savedToken, null);
  assert.deepEqual(session.restoredTokens, []);
  assert.deepEqual(session.authorization, []);
  assert.deepEqual(session.health, []);
});

test('a stale migration failure cannot change a newer session', async () => {
  let failEncryption!: (error: Error) => void;
  const encryption = new Promise<string>((_resolve, reject) => {
    failEncryption = reject;
  });
  const session = startRestoration({ savedToken: legacyToken, encryption });
  await drainTasks();
  session.resolve(null);
  await drainTasks();
  session.savedToken = 'another-tab-ciphertext';
  failEncryption(new Error('Storage unavailable'));
  await drainTasks();
  assert.equal(session.savedToken, 'another-tab-ciphertext');
  assert.deepEqual(session.restoredTokens, ['new-admin']);
  assert.deepEqual(session.authorization, [true]);
  assert.deepEqual(session.health, [true]);
  assert.deepEqual(session.encryptedTokens, ['legacy-admin']);
  assert.deepEqual(session.errors, []);
});

test('concurrent legacy migrations complete restoration in both tabs', async () => {
  const sharedStorage = { savedToken: legacyToken };
  const replacementTokens = { 'tab-A-ciphertext': 'legacy-admin' };
  let finishA!: (token: string) => void;
  let finishB!: (token: string) => void;
  const tabA = startRestoration({
    sharedStorage,
    replacementTokens,
    encryption: new Promise<string>((resolve) => {
      finishA = resolve;
    }),
  });
  const tabB = startRestoration({
    sharedStorage,
    replacementTokens,
    encryption: new Promise<string>((resolve) => {
      finishB = resolve;
    }),
  });
  await drainTasks();
  tabA.resolve(null);
  tabB.resolve(null);
  await drainTasks();
  assert.deepEqual(tabA.encryptedTokens, ['legacy-admin']);
  assert.deepEqual(tabB.encryptedTokens, ['legacy-admin']);
  finishA('tab-A-ciphertext');
  await drainTasks();
  finishB('tab-B-ciphertext');
  await drainTasks();
  assert.equal(sharedStorage.savedToken, 'tab-A-ciphertext');
  for (const tab of [tabA, tabB]) {
    assert.deepEqual(tab.restoredTokens, ['legacy-admin']);
    assert.deepEqual(tab.authorization, [true]);
    assert.deepEqual(tab.health, [true]);
    assert.deepEqual(tab.encryptedTokens, ['legacy-admin']);
    assert.deepEqual(tab.errors, []);
    assert.equal(tab.events.filter((event) => event === 'write').length, tab === tabA ? 1 : 0);
  }
});
