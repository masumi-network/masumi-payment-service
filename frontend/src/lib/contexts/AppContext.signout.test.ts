import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = ts.createSourceFile(
  'AppContext.tsx',
  readFileSync(new URL('./AppContext.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

function callbackSource(name: string): string {
  let callback: ts.ArrowFunction | undefined;
  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === name &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.expression.getText(source) === 'useCallback' &&
      node.initializer.arguments[0] &&
      ts.isArrowFunction(node.initializer.arguments[0])
    ) {
      callback = node.initializer.arguments[0];
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(callback, `${name} callback must exist`);
  return ts.transpileModule(`(${callback.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}

test('sign-out replaces the authenticated client and removes cached account queries', () => {
  const removedStorageKeys: string[] = [];
  const clients: Array<{ headers?: { token: string } }> = [];
  let removedQueries = 0;
  let currentApiKey: string | null = 'old-secret';
  const noOp = () => {};
  const context = {
    apiKeyRef: { current: 'old-secret' },
    setApiKey: (value: string | null) => {
      currentApiKey = value;
    },
    setApiClient: (client: { headers?: { token: string } }) => clients.push(client),
    createClient: (options: { headers?: { token: string } }) => options,
    setAuthorized: noOp,
    setCapabilities: noOp,
    DEFAULT_CAPABILITIES: {},
    queryClient: {
      removeQueries: () => {
        removedQueries += 1;
      },
    },
    process: { env: { NEXT_PUBLIC_PAYMENT_API_BASE_URL: 'http://localhost' } },
    setNetwork: noOp,
    setSelectedPaymentSourceId: noOp,
    setIsChangingNetwork: noOp,
    setIsSetupMode: noOp,
    setSetupWizardStep: noOp,
    setActiveRail: noOp,
    setSelectedX402ChainId: noOp,
    localStorage: { removeItem: (key: string) => removedStorageKeys.push(key) },
  };
  const updateApiKey = runInNewContext(callbackSource('updateApiKey'), context) as (
    key: string | null,
  ) => void;
  const signOut = runInNewContext(callbackSource('signOut'), {
    ...context,
    updateApiKey,
  }) as () => void;

  signOut();

  assert.equal(currentApiKey, null);
  assert.equal(clients.at(-1)?.headers?.token, 'invalid-api');
  assert.equal(removedQueries, 1);
  assert.ok(removedStorageKeys.includes('payment_api_key'));
});
