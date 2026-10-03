const DB_NAME = 'masumi-secure-storage';
const STORE_NAME = 'keys';
const KEY_ID = 'api-key-encryption-key';
const IV_LENGTH_BYTES = 12;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadStoredKey(): Promise<CryptoKey | null> {
  const db = await openDb();
  try {
    return await new Promise<CryptoKey | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(KEY_ID);
      tx.oncomplete = () => resolve((request.result as CryptoKey | undefined) ?? null);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function saveKeyIfAbsent(key: CryptoKey): Promise<CryptoKey> {
  const db = await openDb();
  try {
    return await new Promise<CryptoKey>((resolve, reject) => {
      // IndexedDB serializes read/write transactions across tabs. Recheck
      // inside this transaction so a competing tab's key is never replaced.
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(KEY_ID);
      let selectedKey = key;
      request.onsuccess = () => {
        const existing = request.result as CryptoKey | undefined;
        if (existing) selectedKey = existing;
        else store.put(key, KEY_ID);
      };
      tx.oncomplete = () => resolve(selectedKey);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

let keyPromise: Promise<CryptoKey> | null = null;

// Non-extractable: the raw key material never exists as a string or byte
// array script can read back out, only as an opaque CryptoKey handle.
function getOrCreateKey(): Promise<CryptoKey> {
  if (keyPromise == null) {
    keyPromise = (async () => {
      const existing = await loadStoredKey();
      if (existing) return existing;
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt',
      ]);
      return saveKeyIfAbsent(key);
    })().catch((error: unknown) => {
      keyPromise = null;
      throw error;
    });
  }
  return keyPromise;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function encryptWithKey(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return toBase64(combined);
}

export async function decryptWithKey(key: CryptoKey, stored: string): Promise<string | null> {
  try {
    const combined = fromBase64(stored);
    if (combined.length <= IV_LENGTH_BYTES) return null;
    const iv = combined.slice(0, IV_LENGTH_BYTES);
    const ciphertext = combined.slice(IV_LENGTH_BYTES);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

export async function encryptForStorage(plaintext: string): Promise<string> {
  const key = await getOrCreateKey();
  return encryptWithKey(key, plaintext);
}

export async function decryptFromStorage(stored: string): Promise<string | null> {
  // Storage errors must reach the caller. Only invalid ciphertext returns
  // null, so a temporary IndexedDB failure does not discard a saved token.
  const key = await getOrCreateKey();
  return decryptWithKey(key, stored);
}
