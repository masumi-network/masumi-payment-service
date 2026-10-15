/**
 * Test support: stage a redemption and confirm it, as the owning service does
 * after it verifies the signature. Not used by the Host itself.
 */

import type { ExchangeStore } from './exchange-store.js';
import type { ExchangeMaterial, ExchangeSignature } from './exchange-types.js';

export async function stageAndConfirm(
	store: ExchangeStore,
	nonce: string,
	redeemer: ExchangeMaterial,
	signature: ExchangeSignature,
) {
	const staged = await store.stage(nonce, redeemer, signature);
	if (!staged.ok) return staged;
	const invite = (await store.listInvites()).find((candidate) => candidate.nonce === nonce);
	const candidate = invite?.staged.find(
		(entry) => entry.signature.signature === signature.signature && entry.signature.key === signature.key,
	);
	if (candidate === undefined) throw new Error(`no staged redemption for ${nonce}`);
	return await store.confirmStaged(nonce, candidate.id);
}
