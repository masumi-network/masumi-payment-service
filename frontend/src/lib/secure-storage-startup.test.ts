import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

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

function startRestoration() {
  let savedToken: string | null = 'original-ciphertext';
  let resolve!: (value: string | null) => void;
  let reject!: (error: Error) => void;
  const decryption = new Promise<string | null>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  const authorization: boolean[] = [];
  const errors: string[] = [];
  const configuredTokens: string[] = [];
  const restoredTokens: string[] = [];
  const cleanup: () => void = runInNewContext(effectScript, {
    handleApiCall: (call: () => Promise<object>) => call(),
    getHealth: async () => ({}),
    getApiKeyStatus: async () => ({ data: { data: {} } }),
    decryptFromStorage: () => decryption,
    localStorage: {
      getItem: () => savedToken,
      removeItem: () => {
        savedToken = null;
      },
    },
    apiClient: {
      setConfig: (config: { headers: { token: string } }) => {
        configuredTokens.push(config.headers.token);
      },
    },
    setIsHealthy: () => {},
    setAuthorized: (value: boolean) => authorization.push(value),
    capabilitiesFromApiKeyStatus: () => ({ canRead: true }),
    setCapabilities: () => {},
    updateApiKey: (value: string) => restoredTokens.push(value),
    signOut: () => {},
    toast: { error: (message: string) => errors.push(message) },
  });
  return {
    resolve,
    reject,
    cleanup,
    authorization,
    errors,
    configuredTokens,
    restoredTokens,
    get savedToken() {
      return savedToken;
    },
    set savedToken(value: string | null) {
      savedToken = value;
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

test('a stale failed decryption cannot delete a newer token', async () => {
  const session = startRestoration();
  await drainTasks();
  session.savedToken = 'new-ciphertext';
  session.resolve(null);
  await drainTasks();
  assert.equal(session.savedToken, 'new-ciphertext');
  assert.deepEqual(session.authorization, []);
});

test('a stale storage error cannot change a newer session', async () => {
  const session = startRestoration();
  await drainTasks();
  session.savedToken = 'new-ciphertext';
  session.reject(new Error('Storage temporarily unavailable'));
  await drainTasks();
  assert.equal(session.savedToken, 'new-ciphertext');
  assert.deepEqual(session.authorization, []);
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
});
