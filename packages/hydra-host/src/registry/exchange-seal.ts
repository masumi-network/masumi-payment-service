import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { isPlainObject } from './json.js';

const FORMAT = 'hydra-exchange-v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function isHex(value: unknown, bytes: number | null = null): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length % 2 === 0 &&
		(bytes === null || value.length === bytes * 2) &&
		/^[0-9a-f]+$/.test(value)
	);
}

export function sealExchangeState(state: unknown, key: Buffer): string {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	cipher.setAAD(Buffer.from(FORMAT));
	const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
	return `${JSON.stringify({
		format: FORMAT,
		iv: iv.toString('hex'),
		tag: cipher.getAuthTag().toString('hex'),
		ciphertext: ciphertext.toString('hex'),
	})}\n`;
}

export function openExchangeState(raw: string, key: Buffer): { state: unknown; isLegacy: boolean } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error('exchange.json is not valid JSON');
	}
	if (!isPlainObject(parsed)) throw new Error('exchange.json does not contain an exchange state');
	if (!Object.hasOwn(parsed, 'format')) return { state: parsed, isLegacy: true };
	if (
		parsed.format !== FORMAT ||
		!isHex(parsed.iv, IV_BYTES) ||
		!isHex(parsed.tag, TAG_BYTES) ||
		!isHex(parsed.ciphertext)
	) {
		throw new Error('exchange.json has an unsupported or invalid encrypted format');
	}
	try {
		const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.iv, 'hex'));
		decipher.setAAD(Buffer.from(FORMAT));
		decipher.setAuthTag(Buffer.from(parsed.tag, 'hex'));
		const cleartext = Buffer.concat([decipher.update(Buffer.from(parsed.ciphertext, 'hex')), decipher.final()]);
		return { state: JSON.parse(cleartext.toString('utf8')) as unknown, isLegacy: false };
	} catch {
		throw new Error('exchange.json authentication failed; check HYDRA_HOST_EXCHANGE_KEY and the file');
	}
}
