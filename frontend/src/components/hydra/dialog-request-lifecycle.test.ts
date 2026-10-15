import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
// The harness runs actual component handlers and layout cleanup without a DOM.
// It does not model Radix events, React scheduling or browser painting.
type Element = {
  props: {
    children?: any;
    onClick?: () => void;
    onValueChange?: (value: string) => void;
    disabled?: boolean;
  };
};
function deferred() {
  let resolve!: (value: any) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<any>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
}
function mount(kind: 'backup' | 'invite', requests: ReturnType<typeof deferred>[]) {
  const slots: any[] = [];
  const effects: (() => void)[] = [];
  const errors: string[] = [];
  let cursor = 0;
  let calls = 0;
  let refreshes = 0;
  let unmounted = false;
  let writesAfterUnmount = 0;
  let tree: Element;
  const props = {
    open: true,
    participantId: 'participant-a',
    onOpenChange: (open: boolean) => {
      props.open = open;
    },
    onDone: () => {
      refreshes++;
    },
    onIssued: () => {
      refreshes++;
    },
  };
  const context = {
    apiClient: {},
    network: 'Preprod',
    selectedPaymentSource: { id: 'source-a', paymentSourceType: 'Web3CardanoV2' },
  };
  function effect(run: () => any, dependencies: any[]) {
    const index = cursor++;
    const previous = slots[index];
    if (
      !previous ||
      dependencies.some((value, position) => value !== previous.dependencies[position])
    ) {
      effects.push(() => {
        previous?.cleanup?.();
        slots[index] = { dependencies, cleanup: run() };
      });
    }
  }
  const react = {
    useState(initial: any) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [
        slots[index],
        (value: any) => {
          if (unmounted) writesAfterUnmount++;
          slots[index] = typeof value === 'function' ? value(slots[index]) : value;
        },
      ];
    },
    useRef(initial: any) {
      const index = cursor++;
      return slots[index] ?? (slots[index] = { current: initial });
    },
    useMemo(compute: () => any) {
      return compute();
    },
    useEffect: effect,
    useLayoutEffect: effect,
  };
  const componentName = kind === 'backup' ? 'BackUpNodeKeysDialog' : 'IssueHydraInviteDialog';
  const loadedModule = { exports: {} as any };
  const code = ts.transpileModule(
    readFileSync(new URL(`./${componentName}.tsx`, import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } },
  ).outputText;
  runInNewContext(code, {
    exports: loadedModule.exports,
    module: loadedModule,
    require: (name: string) => {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return require(name);
      if (name === 'react-toastify')
        return { toast: { error: (message: string) => errors.push(message) } };
      if (name.endsWith('/AppContext')) return { useAppContext: () => context };
      if (name.endsWith('/useWallets'))
        return {
          useWallets: () => ({
            wallets: [{ id: 'wallet-a', type: 'Purchasing', walletAddress: 'addr_test_a' }],
          }),
        };
      if (name.endsWith('/useHydraHeads'))
        return {
          revealHydraNodeKeys: () => requests[calls++].promise,
          createHydraInvite: () => requests[calls++].promise,
        };
      if (name.endsWith('/DurationPicker'))
        return { DurationPicker: 'DurationPicker', formatDuration: String };
      return new Proxy({}, { get: (_target, name) => String(name) });
    },
  });
  function render() {
    cursor = 0;
    tree = loadedModule.exports[componentName](props);
    while (effects.length) effects.shift()!();
    cursor = 0;
    tree = loadedModule.exports[componentName](props);
  }
  function find(
    predicate: (element: Element) => boolean,
    element: Element | undefined,
  ): Element | undefined {
    if (!element || typeof element !== 'object') return undefined;
    if (predicate(element)) return element;
    const children = element.props?.children;
    for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) {
      const found = find(predicate, child);
      if (found) return found;
    }
    return undefined;
  }
  function button(label: string) {
    const found = find(
      (element) =>
        !!element.props?.onClick && JSON.stringify(element.props.children).includes(label),
      tree,
    );
    assert.ok(found, label);
    return found;
  }
  function start() {
    if (kind === 'backup') {
      button('Reveal keys').props.onClick!();
      return;
    }
    button('We buy').props.onClick!();
    render();
    find((element) => typeof element.props?.onValueChange === 'function', tree)!.props
      .onValueChange!('wallet-a');
    render();
    button('Create invite').props.onClick!();
  }
  render();
  return {
    props,
    context,
    render,
    button,
    start,
    errors,
    unmount: () => {
      unmounted = true;
      for (const slot of slots) slot?.cleanup?.();
    },
    has: (text: string) => JSON.stringify(tree).includes(text),
    calls: () => calls,
    refreshes: () => refreshes,
    writesAfterUnmount: () => writesAfterUnmount,
  };
}
const keys = { hydraSigningKey: 'secret-key-a', cardanoSigningKey: 'secret-cardano-a' };
const invite = { code: 'bearer-code-a', expiresAt: '2027-01-01T00:00:00Z' };
const flush = async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};
for (const kind of ['backup', 'invite'] as const) {
  const result = kind === 'backup' ? keys : invite;
  const secret = kind === 'backup' ? keys.hydraSigningKey : invite.code;
  const action = kind === 'backup' ? 'Reveal keys' : 'Create invite';
  test(`${kind}: late success cannot restore secrets or clear a newer loading state`, async () => {
    const first = deferred();
    const second = deferred();
    const dialog = mount(kind, [first, second]);
    dialog.start();
    dialog.button(kind === 'backup' ? 'Not now' : 'Cancel').props.onClick!();
    dialog.props.open = true;
    dialog.render();
    dialog.start();
    first.resolve(result);
    await flush();
    dialog.render();
    assert.equal(dialog.has(secret), false);
    assert.equal(dialog.button(action).props.disabled, true);
    second.resolve(result);
    await flush();
    dialog.render();
    assert.equal(dialog.has(secret), true);
    assert.equal(dialog.refreshes(), 2);
  });
  test(`${kind}: stale errors stay silent after external close and unmount`, async () => {
    for (const unmount of [false, true]) {
      const pending = deferred();
      const dialog = mount(kind, [pending]);
      dialog.start();
      if (unmount) dialog.unmount();
      else {
        dialog.props.open = false;
        dialog.render();
      }
      pending.reject(new Error('stale error'));
      await flush();
      assert.deepEqual(dialog.errors, []);
    }
  });
  test(`${kind}: duplicate submission starts one request`, () => {
    const dialog = mount(kind, [deferred()]);
    dialog.start();
    dialog.render();
    dialog.button(action).props.onClick!();
    assert.equal(dialog.calls(), 1);
  });
  test(`${kind}: API context change rejects pending secrets`, async () => {
    const pending = deferred();
    const dialog = mount(kind, [pending]);
    dialog.start();
    dialog.context.apiClient = {};
    dialog.render();
    pending.resolve(result);
    await flush();
    dialog.render();
    assert.equal(dialog.has(secret), false);
  });
}
test('backup: participant change rejects pending keys but refreshes metadata', async () => {
  const pending = deferred();
  const dialog = mount('backup', [pending]);
  dialog.start();
  dialog.props.participantId = 'participant-b';
  dialog.render();
  pending.resolve(keys);
  await flush();
  dialog.render();
  assert.equal(dialog.has(keys.hydraSigningKey), false);
  assert.equal(dialog.refreshes(), 1);
});
test('invite: source and network changes reject pending bearer codes', async () => {
  for (const change of ['source', 'network']) {
    const pending = deferred();
    const dialog = mount('invite', [pending]);
    dialog.start();
    if (change === 'source') dialog.context.selectedPaymentSource.id = 'source-b';
    else dialog.context.network = 'Mainnet';
    dialog.render();
    pending.resolve(invite);
    await flush();
    dialog.render();
    assert.equal(dialog.has(invite.code), false);
  }
});

for (const kind of ['backup', 'invite'] as const) {
  test(`${kind}: unmount rejects success writes but preserves metadata refresh`, async () => {
    const pending = deferred();
    const dialog = mount(kind, [pending]);
    dialog.start();
    dialog.unmount();
    pending.resolve(kind === 'backup' ? keys : invite);
    await flush();
    assert.equal(dialog.writesAfterUnmount(), 0);
    assert.equal(dialog.refreshes(), 1);
  });
}

test('backup: participant change clears already revealed keys', async () => {
  const pending = deferred();
  const dialog = mount('backup', [pending]);
  dialog.start();
  pending.resolve(keys);
  await flush();
  dialog.render();
  assert.equal(dialog.has(keys.hydraSigningKey), true);
  dialog.props.participantId = 'participant-b';
  dialog.render();
  assert.equal(dialog.has(keys.hydraSigningKey), false);
});
