import LZString from 'lz-string';
import stringify from 'canonical-json';

export function extractErrorMessage(
  error: unknown,
  fallback: string = 'An error occurred',
): string {
  if (!error) return fallback;

  if (typeof error === 'string') return error;

  if (error instanceof Error) return error.message;

  if (typeof error === 'object') {
    const err = error as Record<string, unknown>;

    if (typeof err.message === 'string') return err.message;
    if (typeof err.error === 'string') return err.error;
    if (typeof err.statusText === 'string') return err.statusText;

    if (err.data && typeof err.data === 'object') {
      const data = err.data as Record<string, unknown>;
      if (typeof data.message === 'string') return data.message;
      if (typeof data.error === 'string') return data.error;
    }

    try {
      const stringified = JSON.stringify(error);
      if (stringified && stringified !== '{}') {
        return stringified.length > 200 ? stringified.substring(0, 200) + '...' : stringified;
      }
    } catch {}
  }

  return fallback;
}

// Generate random hex string for identifierFromPurchaser (14-26 chars)
export function generateRandomHex(length: number = 16): string {
  const array = new Uint8Array(length / 2);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Generate SHA256 hash using Web Crypto API (browser-compatible)
export async function generateSHA256Hex(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// MIP-004 Input Hash: SHA256(identifierFromPurchaser + ";" + JCS(input_data))
export async function generateMIP004InputHash(
  inputData: Record<string, unknown>,
  identifierFromPurchaser: string,
): Promise<string> {
  const canonicalJson = stringify(inputData);
  const preImage = identifierFromPurchaser + ';' + canonicalJson;
  return generateSHA256Hex(preImage);
}

// Calculate default times with proper offsets
export function calculateDefaultTimes() {
  const now = Date.now();
  const payByTime = new Date(now + 60 * 60 * 1000); // +1 hour
  const submitResultTime = new Date(now + 6 * 60 * 60 * 1000); // +6 hours
  const unlockTime = new Date(now + 12 * 60 * 60 * 1000); // +12 hours
  const externalDisputeUnlockTime = new Date(now + 18 * 60 * 60 * 1000); // +18 hours
  return { payByTime, submitResultTime, unlockTime, externalDisputeUnlockTime };
}

// Get proper base URL with fallback
function getBaseUrl(baseUrl: string): string {
  // Check if baseUrl is valid (not empty and starts with http)
  if (baseUrl && baseUrl.startsWith('http')) {
    return baseUrl;
  }
  return 'http://localhost:3001';
}

// Generate curl command for payment
// Note: Payment API accepts dates as ISO strings
export function generatePaymentCurl(baseUrl: string, apiKey: string, body: object): string {
  const url = getBaseUrl(baseUrl);
  return `curl -X POST "${url}/api/v1/payment/" \\
  -H "Content-Type: application/json" \\
  -H "token: ${apiKey}" \\
  -d '${JSON.stringify(body, null, 2)}'`;
}

export function generatePurchaseCurl(baseUrl: string, apiKey: string, body: object): string {
  const url = getBaseUrl(baseUrl);
  return `curl -X POST "${url}/api/v1/purchase/" \\
  -H "Content-Type: application/json" \\
  -H "token: ${apiKey}" \\
  -d '${JSON.stringify(body, null, 2)}'`;
}

function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function isValidHex(str: string): boolean {
  return /^[0-9a-fA-F]+$/.test(str) && str.length % 2 === 0;
}

export function decodeBlockchainIdentifier(blockchainIdentifier: string): {
  sellerId: string;
  purchaserId: string;
  signature: string;
  key: string;
  agentIdentifier: string | null;
} | null {
  try {
    if (!isValidHex(blockchainIdentifier)) return null;

    const bytes = hexToUint8Array(blockchainIdentifier);
    const decompressed = LZString.decompressFromUint8Array(bytes);

    if (typeof decompressed !== 'string') return null;

    const parts = decompressed.split('.');
    if (parts.length !== 4) return null;

    const sellerId = parts[0];
    const purchaserId = parts[1];
    const signature = parts[2];
    const key = parts[3];

    if (!isValidHex(sellerId) || !isValidHex(purchaserId)) return null;

    const agentIdentifier = sellerId.length > 64 ? sellerId.slice(64) : null;

    return { sellerId, purchaserId, signature, key, agentIdentifier };
  } catch {
    return null;
  }
}
