import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type * as SecureStorage from './secure-storage';

type StorageModule = typeof SecureStorage;
type Callback = (() => void) | null;
let moduleId = 0;

function freshStorage(): Promise<StorageModule> {
  moduleId += 1;
  return import(new URL(`./secure-storage.ts?test=${moduleId}`, import.meta.url).href);
}

// Model request ordering, transaction isolation, and commit/abort. This does
// not cover browser-specific storage permissions or persistence on disk.
function createDatabase() {
  let storedKey: CryptoKey | undefined;
  let queue = Promise.resolve();
  let writes = 0;
  let opens = 0;
  let closes = 0;
  let openError: DOMException | null = null;
  let abortWrite = false;

  const database = {
    close() {
      closes += 1;
    },
    createObjectStore() {},
    transaction(_store: string, mode: IDBTransactionMode) {
      const operations: (() => void)[] = [];
      let pendingKey: CryptoKey | undefined;
      const tx = {
        error: null as DOMException | null,
        oncomplete: null as Callback,
        onerror: null as Callback,
        onabort: null as Callback,
        objectStore() {
          return {
            get() {
              const request = {
                result: undefined as CryptoKey | undefined,
                onsuccess: null as Callback,
                onerror: null as Callback,
              };
              operations.push(() => {
                request.result = storedKey && structuredClone(storedKey);
                request.onsuccess?.();
              });
              return request;
            },
            put(key: CryptoKey) {
              assert.equal(mode, 'readwrite');
              operations.push(() => {
                pendingKey = structuredClone(key);
              });
            },
          };
        },
      };
      queue = queue.then(() => {
        for (const operation of operations) operation();
        if (abortWrite && pendingKey) {
          abortWrite = false;
          tx.error = new DOMException('Storage transaction aborted', 'AbortError');
          tx.onabort?.();
          return;
        }
        if (pendingKey) {
          storedKey = pendingKey;
          writes += 1;
        }
        tx.oncomplete?.();
      });
      return tx;
    },
  };

  return {
    factory: {
      open() {
        opens += 1;
        const failure = openError;
        openError = null;
        const request = {
          result: database,
          error: failure,
          onsuccess: null as Callback,
          onerror: null as Callback,
          onupgradeneeded: null as Callback,
        };
        queueMicrotask(() => {
          if (failure) request.onerror?.();
          else request.onsuccess?.();
        });
        return request;
      },
    },
    failNextOpen() {
      openError = new DOMException('Storage temporarily unavailable', 'UnknownError');
    },
    abortNextWrite() {
      abortWrite = true;
    },
    get key() {
      return storedKey;
    },
    get writes() {
      return writes;
    },
    get opens() {
      return opens;
    },
    get closes() {
      return closes;
    },
  };
}

function installDatabase(t: TestContext, db: ReturnType<typeof createDatabase>) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: db.factory });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'indexedDB', original);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
  });
}

test('concurrent first use in separate tabs preserves both tokens after reload', async (t) => {
  const db = createDatabase();
  installDatabase(t, db);
  const [tabA, tabB] = await Promise.all([freshStorage(), freshStorage()]);
  const generateKey = crypto.subtle.generateKey.bind(crypto.subtle);
  let generated = 0;
  let release!: () => void;
  const bothGenerated = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(crypto.subtle, 'generateKey', async (...args: Parameters<typeof generateKey>) => {
    const key = await generateKey(...args);
    generated += 1;
    if (generated === 2) release();
    await bothGenerated;
    return key;
  });

  const [tokenA, tokenB] = await Promise.all([
    tabA.encryptForStorage('admin-A'),
    tabB.encryptForStorage('admin-B'),
  ]);
  const reloaded = await freshStorage();
  assert.equal(await reloaded.decryptFromStorage(tokenA), 'admin-A');
  assert.equal(await reloaded.decryptFromStorage(tokenB), 'admin-B');
  assert.equal(db.writes, 1);
});

test('a temporary storage failure rejects and allows retry without reload', async (t) => {
  const db = createDatabase();
  installDatabase(t, db);
  const storage = await freshStorage();
  db.failNextOpen();
  await assert.rejects(storage.decryptFromStorage('saved-ciphertext'), { name: 'UnknownError' });
  const token = await storage.encryptForStorage('admin');
  assert.equal(await storage.decryptFromStorage(token), 'admin');
  assert.ok(db.opens > 1);
});

test(
  'an aborted key write rejects and allows retry without caching an uncommitted key',
  { timeout: 1000 },
  async (t) => {
    const db = createDatabase();
    installDatabase(t, db);
    const storage = await freshStorage();
    db.abortNextWrite();
    await assert.rejects(storage.encryptForStorage('admin'), { name: 'AbortError' });
    assert.equal(db.key, undefined);
    const token = await storage.encryptForStorage('admin');
    const reloaded = await freshStorage();
    assert.equal(await reloaded.decryptFromStorage(token), 'admin');
  },
);

test('stored keys remain non-extractable and database connections close', async (t) => {
  const db = createDatabase();
  installDatabase(t, db);
  const storage = await freshStorage();
  const token = await storage.encryptForStorage('admin');
  assert.ok(db.key);
  assert.equal(db.key.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('raw', db.key));
  const reloaded = await freshStorage();
  assert.equal(await reloaded.decryptFromStorage(token), 'admin');
  assert.equal(db.closes, db.opens);
});

test('malformed and altered ciphertext return null', async (t) => {
  const db = createDatabase();
  installDatabase(t, db);
  const storage = await freshStorage();
  const token = await storage.encryptForStorage('admin');
  assert.equal(await storage.decryptFromStorage('!invalid-base64!'), null);
  assert.equal(await storage.decryptFromStorage(btoa('short')), null);
  const bytes = Uint8Array.from(atob(token), (character) => character.charCodeAt(0));
  bytes[bytes.length - 1] ^= 1;
  assert.equal(await storage.decryptFromStorage(btoa(String.fromCharCode(...bytes))), null);
});

test('legacy hex decoding preserves the exact UTF-8 token', async () => {
  const storage = await freshStorage();
  for (const token of ['legacy-admin', 'Admin-Key', '\uFEFFadmin', 'admin-ä']) {
    assert.equal(storage.decodeLegacyStoredKey(Buffer.from(token).toString('hex')), token);
    assert.equal(
      storage.decodeLegacyStoredKey(Buffer.from(token).toString('hex').toUpperCase()),
      token,
    );
  }
});

test('legacy decoding rejects malformed hex and invalid UTF-8', async () => {
  const storage = await freshStorage();
  for (const value of ['', 'abc', 'zz', '61\n', '61 ', '!base64!', 'ff', 'c328']) {
    assert.equal(storage.decodeLegacyStoredKey(value), null, value);
  }
});

test('encryption preserves a legacy token with a leading UTF-8 byte-order mark', async (t) => {
  const db = createDatabase();
  installDatabase(t, db);
  const storage = await freshStorage();
  const token = '\uFEFFadmin';
  const encrypted = await storage.encryptForStorage(token);
  const reloaded = await freshStorage();
  assert.equal(await reloaded.decryptFromStorage(encrypted), token);
});
