import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createElement, type ReactElement } from 'react';
import ts from 'typescript';

type ElementProps = {
  children?: ReactElement<ElementProps>[];
  onClose?: () => void;
};

// Evaluate the controller and view with shallow UI dependencies. These tests
// exercise their actual event wiring without a browser or network requests.
function loadComponent(file: string, dependencies: (name: string) => object) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  const exports: {
    RegisterAIAgentDialog?: (props: object) => ReactElement;
    RegisterAgentDialogView?: (props: object) => ReactElement<ElementProps>;
  } = {};
  runInNewContext(outputText, { exports, require: dependencies });
  return exports;
}

function renderRegistration() {
  let refreshes = 0;
  const stateChanges: unknown[] = [];
  const noop = () => {};
  const dependencies = (name: string): object => {
    if (name === 'react/jsx-runtime') {
      return { jsx: createElement, jsxs: createElement, Fragment: 'fragment' };
    }
    if (name === 'react') {
      return {
        useState: (initial: unknown) => [initial, (value: unknown) => stateChanges.push(value)],
        useEffect: noop,
        useMemo: (compute: () => unknown) => compute(),
        useCallback: (callback: () => unknown) => callback,
      };
    }
    if (name === '@/lib/queries/useWallets') {
      return { useWallets: () => ({ wallets: [], refetch: () => refreshes++ }) };
    }
    if (name === '@/lib/contexts/AppContext') {
      return { useAppContext: () => ({ network: 'Preprod' }) };
    }
    if (name === 'react-hook-form') {
      return {
        useForm: () => ({ formState: { errors: {} }, watch: () => '', handleSubmit: noop }),
        useFieldArray: () => ({ fields: [] }),
      };
    }
    if (name === './usePaymentOptions') {
      return { usePaymentOptions: () => ({ masumiOptions: [], x402Options: [] }) };
    }
    return new Proxy({}, { get: () => noop });
  };
  const { RegisterAIAgentDialog } = loadComponent('./RegisterAIAgentDialog.tsx', dependencies);
  const { RegisterAgentDialogView } = loadComponent('./RegisterAgentDialogView.tsx', dependencies);
  assert.ok(RegisterAIAgentDialog);
  assert.ok(RegisterAgentDialogView);
  const controller = RegisterAIAgentDialog({ open: true, onClose: noop, onSuccess: noop });
  const view = RegisterAgentDialogView(controller.props as object);
  const topUp = view.props.children?.[1];
  assert.ok(topUp?.props.onClose);
  return { topUp, stateChanges, refreshes: () => refreshes };
}

test('closing registration top-up refreshes wallet balances and clears the selected address', () => {
  const { topUp, stateChanges, refreshes } = renderRegistration();
  assert.equal(refreshes(), 0);
  topUp.props.onClose?.();
  assert.equal(refreshes(), 1);
  assert.equal(stateChanges.at(-1), null);
});
