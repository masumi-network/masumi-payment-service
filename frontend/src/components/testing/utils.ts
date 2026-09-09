import LZString from 'lz-string';
import stringify from 'canonical-json';
import { getOwnPlainObject, getOwnString, getOwnValue, isObject } from '@/lib/object-properties';

export const CURL_API_KEY_PLACEHOLDER = '<your-api-key>';
const CURL_BASE_URL_PLACEHOLDER = '<payment-api-base-url>';

type CanonicalJsonPrimitive = string | number | boolean | null;
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | CanonicalJsonObject
  | CanonicalJsonValue[];
export interface CanonicalJsonObject {
  [key: string]: CanonicalJsonValue;
}

export function extractErrorMessage(
  error: unknown,
  fallback: string = 'An error occurred',
): string {
  if (!error) return fallback;

  if (typeof error === 'string') return error;

  if (error instanceof Error) return error.message;

  if (isObject(error)) {
    const data = getOwnPlainObject(error, 'data');
    const directError = getOwnValue(error, 'error');
    const message = getOwnString(error, 'message');
    const statusText = getOwnString(error, 'statusText');

    if (message !== undefined) return message;
    if (typeof directError === 'string') return directError;
    if (statusText !== undefined) return statusText;

    if (data) {
      const dataMessage = getOwnString(data, 'message');
      if (dataMessage !== undefined) return dataMessage;
      const dataError = getOwnValue(data, 'error');
      if (typeof dataError === 'string') return dataError;
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
  inputData: CanonicalJsonObject,
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

const CURL_API_V1_SUFFIX = '/api/v1';

// Root URL for curl examples shown in the UI (may already include /api/v1).
function resolveCurlBaseUrl(baseUrl: string): string {
  if (baseUrl && baseUrl.startsWith('http')) {
    return baseUrl;
  }
  const configured = process.env.NEXT_PUBLIC_PAYMENT_API_BASE_URL;
  if (configured && configured.startsWith('http')) {
    return configured;
  }
  return CURL_BASE_URL_PLACEHOLDER;
}

function buildCurlEndpointUrl(baseUrl: string, resource: 'payment' | 'purchase'): string {
  const root = resolveCurlBaseUrl(baseUrl).replace(/\/+$/, '');
  const resourcePath = `/${resource}/`;
  if (root.endsWith(CURL_API_V1_SUFFIX)) {
    return `${root}${resourcePath}`;
  }
  return `${root}${CURL_API_V1_SUFFIX}${resourcePath}`;
}

/** HTTP status from a generated-client result (success or axios error). */
export function getClientResponseStatus(result: unknown): number | undefined {
  if (!isObject(result)) return undefined;

  // Success: hey-api spreads AxiosResponse onto the result.
  const topLevelStatus = getOwnValue(result, 'status');
  if (typeof topLevelStatus === 'number') return topLevelStatus;

  // Error: axios error shape stores status on nested response.
  const response = getOwnValue(result, 'response');
  if (!isObject(response)) return undefined;
  const nestedStatus = getOwnValue(response, 'status');
  return typeof nestedStatus === 'number' ? nestedStatus : undefined;
}

// Escape a value for embedding inside single quotes in a POSIX shell command:
// close the quote, emit an escaped quote, reopen the quote.
function escapeShellSingleQuotes(value: string): string {
  return value.replace(/'/g, "'\\''");
}

// Generate curl command for payment (display/copy only; never embeds a live API key).
export function generatePaymentCurl(baseUrl: string, body: object): string {
  const url = buildCurlEndpointUrl(baseUrl, 'payment');
  return `curl -X POST "${url}" \\
  -H "Content-Type: application/json" \\
  -H "token: ${CURL_API_KEY_PLACEHOLDER}" \\
  -d '${escapeShellSingleQuotes(JSON.stringify(body, null, 2))}'`;
}

export function generatePurchaseCurl(baseUrl: string, body: object): string {
  const url = buildCurlEndpointUrl(baseUrl, 'purchase');
  return `curl -X POST "${url}" \\
  -H "Content-Type: application/json" \\
  -H "token: ${CURL_API_KEY_PLACEHOLDER}" \\
  -d '${escapeShellSingleQuotes(JSON.stringify(body, null, 2))}'`;
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
  smartContractAddress: string | null;
} | null {
  try {
    if (!isValidHex(blockchainIdentifier)) return null;

    const bytes = hexToUint8Array(blockchainIdentifier);
    const decompressed = LZString.decompressFromUint8Array(bytes);

    if (typeof decompressed !== 'string') return null;

    // Mirrors packages/payment-core/src/blockchain-identifier.ts: Web3CardanoV2
    // sources append the smart contract address as an optional 5th segment.
    const parts = decompressed.split('.');
    if (parts.length !== 4 && parts.length !== 5) return null;

    const sellerId = parts[0];
    const purchaserId = parts[1];
    const signature = parts[2];
    const key = parts[3];
    const smartContractAddress = parts.length === 5 ? parts[4] : null;

    if (!isValidHex(sellerId) || !isValidHex(purchaserId)) return null;

    if (smartContractAddress != null) {
      // Cardano bech32 addresses are ~108 chars; allow generous buffer and
      // require the 'addr' prefix (covers 'addr1...' and 'addr_test1...').
      if (smartContractAddress.length > 250 || !smartContractAddress.startsWith('addr')) {
        return null;
      }
    }

    const agentIdentifier = sellerId.length > 64 ? sellerId.slice(64) : null;

    return { sellerId, purchaserId, signature, key, agentIdentifier, smartContractAddress };
  } catch {
    return null;
  }
}
