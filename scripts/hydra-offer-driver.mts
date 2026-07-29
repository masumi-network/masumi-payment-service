/**
 * Plays the *initiating* operator against a running payment service.
 *
 * Provisions a node on a Hydra Host, signs a head offer with the counterparty
 * wallet the target's relation records, and posts it to
 * `/api/v1/hydra/handshake/offer`. That is the only way to exercise the inbound
 * signature-authenticated path — the one surface here that is not protected by
 * an API key — without a second payment-service deployment.
 *
 * Test support only.
 */

import { MeshWallet, checkSignature } from '@meshsdk/core';
import stringify from 'canonical-json';
import { createId } from '@paralleldrive/cuid2';
import { generateSHA256Hash } from '@/utils/crypto';
import { buildHydraHeadOfferPayload, type HydraHeadOfferPayloadInput } from '@/services/hydra-handshake/offer-payload';
import { acknowledgeEscrowOnHost, provisionNodeOnHost } from '@/services/hydra-host/client';

const TARGET = process.env.DRIVER_TARGET ?? 'http://127.0.0.1:3010';
const HOST_URL = process.env.DRIVER_HOST_URL ?? 'http://127.0.0.1:18600';
const HOST_ADMIN_TOKEN = process.env.DRIVER_HOST_ADMIN_TOKEN ?? '';
const MNEMONIC = (process.env.DRIVER_MNEMONIC ?? '').split(' ').filter((word) => word.length > 0);
const RELATION_ID = process.env.DRIVER_RELATION_ID ?? '';
const HEAD_SEQUENCE = Number(process.env.DRIVER_HEAD_SEQUENCE ?? '1');
/** Deliberately wrong signer, to prove the inbound endpoint rejects strangers. */
const IMPERSONATE = process.env.DRIVER_IMPERSONATE === 'true';

async function main(): Promise<void> {
	const words = IMPERSONATE ? (MeshWallet.brew() as string[]) : MNEMONIC;
	const wallet = new MeshWallet({ networkId: 0, key: { type: 'mnemonic', words } });
	const address = await wallet.getChangeAddress();

	const provisioned = await provisionNodeOnHost(HOST_URL, HOST_ADMIN_TOKEN, `driver-${createId()}`, {
		contestationPeriodSeconds: 220,
		depositPeriodSeconds: 300,
		unsyncedPeriodSeconds: 1800,
	});
	if (provisioned.secrets !== null) {
		await acknowledgeEscrowOnHost(HOST_URL, HOST_ADMIN_TOKEN, provisioned.nodeId);
	}
	console.log(`[driver] provisioned ${provisioned.nodeId} advertise=${provisioned.advertise}`);

	const offer: HydraHeadOfferPayloadInput = {
		hydraRelationId: RELATION_ID,
		headSequence: HEAD_SEQUENCE,
		nonce: createId(),
		expiresAt: String(Date.now() + 15 * 60 * 1000),
		network: 'Preprod',
		hydraVerificationKey: provisioned.hydraVerificationKey,
		cardanoVerificationKey: provisioned.cardanoVerificationKey,
		advertise: provisioned.advertise,
		contestationPeriodSeconds: 220,
		depositPeriodSeconds: 300,
		unsyncedPeriodSeconds: 1800,
		ledgerParamsHash: null,
	};

	const hashed = generateSHA256Hash(stringify(buildHydraHeadOfferPayload(offer)));
	const signed = await wallet.signData(hashed, address);
	console.log(`[driver] signing as ${IMPERSONATE ? 'A STRANGER (should be rejected)' : 'the relation counterparty'}`);

	const response = await fetch(`${TARGET}/api/v1/hydra/handshake/offer`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ offer, signature: { signature: signed.signature, key: signed.key } }),
	});
	const body = (await response.json()) as {
		status?: string;
		data?: { accepted?: boolean; offer?: HydraHeadOfferPayloadInput; signature?: { signature: string; key: string } };
		error?: { message?: string };
	};

	console.log(`[driver] target responded ${response.status}`);
	if (response.status !== 200) {
		console.log(`[driver] error: ${body.error?.message ?? 'unknown'}`);
		return;
	}

	// Verify their acceptance the way the real initiator would: against the
	// wallet our relation records for them.
	const theirOffer = body.data?.offer;
	const theirSignature = body.data?.signature;
	if (theirOffer === undefined || theirSignature === undefined) {
		console.log('[driver] acceptance was missing material');
		return;
	}
	const theirHash = generateSHA256Hash(stringify(buildHydraHeadOfferPayload(theirOffer)));
	const targetAddress = process.env.DRIVER_TARGET_ADDRESS ?? '';
	const valid = await checkSignature(theirHash, theirSignature, targetAddress);
	console.log(`[driver] their acceptance signature valid: ${valid}`);
	console.log(`[driver] their advertise: ${theirOffer.advertise}`);
}

main()
	.then(() => process.exit(0))
	.catch((error: unknown) => {
		console.error('[driver] failed:', (error as Error).message);
		process.exit(1);
	});
