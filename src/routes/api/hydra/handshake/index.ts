/**
 * Cross-organisation head handshake.
 *
 * These are the only endpoints in the service authenticated by **signature
 * rather than API key**: the caller is another operator's payment service, not
 * a holder of one of our keys. Authority comes from the offer being signed by
 * the wallet already recorded on the Hydra Relation the offer names, so a
 * stranger cannot open a head with us — their offer verifies against no
 * Relation we hold.
 *
 * Responses deliberately do not distinguish "no such relation" from "signature
 * did not verify". Both are 401 with the same body, so this surface cannot be
 * used to enumerate which relations exist.
 */

import { unauthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import createHttpError from 'http-errors';
import { prisma } from '@masumi/payment-core/db';
import { HydraOfferRole, HydraOfferStatus } from '@/generated/prisma/client';
import { checkOfferFreshness, isOfferInitiator } from '@/services/hydra-handshake/offer-payload';
import { canProposeNewOffer } from '@/services/hydra-handshake/offer-state';
import { verifyHydraHeadOffer } from '@/services/hydra-handshake/offer-signing';
import { counterpartyOfferUrl } from '@/services/hydra-handshake/counterparty-url';
import {
	advanceOffer,
	proposeHeadOffer,
	recordCounterpartyMaterial,
	signOwnOffer,
} from '@/services/hydra-handshake/orchestrator';

/** One shape for every rejection, so the surface reveals nothing about our data. */
function rejectUnauthenticated(): never {
	throw createHttpError(401, 'offer could not be authenticated');
}

const offerPayloadSchema = z.object({
	hydraRelationId: z.string().max(64),
	headSequence: z.number().int().min(1),
	nonce: z.string().min(8).max(64),
	expiresAt: z.string().regex(/^\d{1,15}$/),
	network: z.string().max(16),
	hydraVerificationKey: z.string().max(200),
	cardanoVerificationKey: z.string().max(200),
	advertise: z.string().max(260),
	contestationPeriodSeconds: z.number().int().positive(),
	depositPeriodSeconds: z.number().int().positive(),
	unsyncedPeriodSeconds: z.number().int().positive(),
	ledgerParamsHash: z.string().max(120).nullable(),
});

const signatureSchema = z.object({
	signature: z.string().max(4000),
	key: z.string().max(4000),
});

export const receiveHydraOfferSchemaInput = z.object({
	offer: offerPayloadSchema,
	signature: signatureSchema,
});

export const receiveHydraOfferSchemaOutput = z.object({
	accepted: z.boolean(),
	offer: offerPayloadSchema.optional(),
	signature: signatureSchema.optional(),
});

/**
 * Receive a counterparty's offer and answer with our own material.
 *
 * The whole exchange is one round trip: they propose, we provision, and our
 * acceptance carries everything they need to configure their node.
 */
export const receiveHydraOfferPost = unauthenticatedEndpointFactory.build({
	method: 'post',
	input: receiveHydraOfferSchemaInput,
	output: receiveHydraOfferSchemaOutput,
	handler: async ({ input }) => {
		const relation = await prisma.hydraRelation.findUnique({
			where: { id: input.offer.hydraRelationId },
			include: { LocalHotWallet: true, RemoteWallet: true },
		});
		if (!relation) {
			rejectUnauthenticated();
		}

		// Authority: the offer must be signed by the wallet this relation is with.
		try {
			await verifyHydraHeadOffer(input.offer, input.signature, relation.RemoteWallet.walletAddress);
		} catch {
			rejectUnauthenticated();
		}

		if (input.offer.network !== relation.network) {
			rejectUnauthenticated();
		}

		const freshness = checkOfferFreshness(Number(input.offer.expiresAt), Date.now());
		if (!freshness.fresh) {
			throw createHttpError(409, freshness.reason);
		}

		// The proposer is decided by key order, so an offer from the side that
		// should be accepting is a protocol violation rather than a race we can
		// resolve here.
		if (isOfferInitiator(relation.LocalHotWallet.walletVkey, relation.RemoteWallet.walletVkey)) {
			throw createHttpError(409, 'this side is the initiator for this relation; the counterparty must not propose');
		}

		const existing = await prisma.hydraHeadOffer.findFirst({
			where: { hydraRelationId: relation.id, headSequence: input.offer.headSequence },
			orderBy: { createdAt: 'desc' },
		});
		if (existing !== null && existing.nonce === `acceptor:${input.offer.nonce}`) {
			// Replay of the same offer: answer idempotently rather than provisioning
			// a second node.
			const signed = await signOwnOffer(existing.id);
			return { accepted: true, offer: signed.payload, signature: signed.signature };
		}
		if (!canProposeNewOffer(existing)) {
			throw createHttpError(409, 'another offer for this head slot is already in flight');
		}

		const accepted = await acceptCounterpartyOffer(relation.id, input);
		const signed = await signOwnOffer(accepted.offerId);
		void advanceOffer(accepted.offerId);
		return { accepted: true, offer: signed.payload, signature: signed.signature };
	},
});

/** Provision our side and record theirs, as one acceptor-side offer row. */
async function acceptCounterpartyOffer(
	hydraRelationId: string,
	input: z.infer<typeof receiveHydraOfferSchemaInput>,
): Promise<{ offerId: string }> {
	const proposed = await proposeHeadOffer(hydraRelationId, {
		role: HydraOfferRole.Acceptor,
		headSequence: input.offer.headSequence,
		nonce: input.offer.nonce,
		expiresAt: new Date(Number(input.offer.expiresAt)),
		periods: {
			contestationPeriodSeconds: input.offer.contestationPeriodSeconds,
			depositPeriodSeconds: input.offer.depositPeriodSeconds,
			unsyncedPeriodSeconds: input.offer.unsyncedPeriodSeconds,
		},
	});

	await recordCounterpartyMaterial(
		proposed.offerId,
		{
			hydraVerificationKey: input.offer.hydraVerificationKey,
			cardanoVerificationKey: input.offer.cardanoVerificationKey,
			advertise: input.offer.advertise,
		},
		input.signature,
	);
	return { offerId: proposed.offerId };
}

export const declineHydraOfferSchemaInput = z.object({
	nonce: z.string().min(8).max(64),
	signature: signatureSchema,
	offer: offerPayloadSchema,
});
export const declineHydraOfferSchemaOutput = z.object({ declined: z.boolean() });

export const declineHydraOfferPost = unauthenticatedEndpointFactory.build({
	method: 'post',
	input: declineHydraOfferSchemaInput,
	output: declineHydraOfferSchemaOutput,
	handler: async ({ input }) => {
		const offer = await prisma.hydraHeadOffer.findUnique({
			where: { nonce: input.nonce },
			include: { HydraRelation: { include: { RemoteWallet: true } } },
		});
		if (!offer) {
			rejectUnauthenticated();
		}
		try {
			await verifyHydraHeadOffer(input.offer, input.signature, offer.HydraRelation.RemoteWallet.walletAddress);
		} catch {
			rejectUnauthenticated();
		}

		await prisma.hydraHeadOffer.update({
			where: { id: offer.id },
			data: { status: HydraOfferStatus.Declined },
		});
		// Release the node and peer port this offer reserved.
		void advanceOffer(offer.id);
		return { declined: true };
	},
});

export const proposeHydraHeadSchemaInput = z.object({
	hydraRelationId: z.string().describe('Relation to open the next head on'),
});

export const proposeHydraHeadSchemaOutput = z.object({
	offerId: z.string(),
	nonce: z.string(),
	status: z.string(),
});

/** Operator-facing: start the handshake for the next head on a relation. */
export const proposeHydraHeadPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: proposeHydraHeadSchemaInput,
	output: proposeHydraHeadSchemaOutput,
	handler: async ({ input }) => {
		const proposed = await proposeHeadOffer(input.hydraRelationId);
		const status = await deliverOffer(proposed.offerId);
		return { offerId: proposed.offerId, nonce: proposed.nonce, status };
	},
});

/** Send our signed offer to the counterparty and record what comes back. */
async function deliverOffer(offerId: string): Promise<string> {
	const offer = await prisma.hydraHeadOffer.findUniqueOrThrow({
		where: { id: offerId },
		include: { HydraRelation: { include: { RemoteWallet: true } } },
	});
	const baseUrl = offer.HydraRelation.counterpartyBaseUrl;
	if (baseUrl === null) {
		throw createHttpError(409, 'relation has no counterparty base URL');
	}

	const signed = await signOwnOffer(offerId);
	const response = await fetch(counterpartyOfferUrl(baseUrl), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		redirect: 'error',
		body: JSON.stringify({ offer: signed.payload, signature: signed.signature }),
	});
	if (!response.ok) {
		throw createHttpError(502, `counterparty refused the offer (${response.status})`);
	}

	const body = (await response.json()) as {
		data?: {
			accepted?: boolean;
			offer?: z.infer<typeof offerPayloadSchema>;
			signature?: { signature: string; key: string };
		};
	};
	const answer = body.data;
	if (answer?.accepted !== true || answer.offer === undefined || answer.signature === undefined) {
		throw createHttpError(502, 'counterparty did not accept the offer');
	}

	// Their acceptance is signed too, and verified the same way.
	// Against the counterparty's ADDRESS, not its row id: the address is what
	// checkSignature binds the signing key to.
	await verifyHydraHeadOffer(answer.offer, answer.signature, offer.HydraRelation.RemoteWallet.walletAddress);
	await recordCounterpartyMaterial(
		offerId,
		{
			hydraVerificationKey: answer.offer.hydraVerificationKey,
			cardanoVerificationKey: answer.offer.cardanoVerificationKey,
			advertise: answer.offer.advertise,
		},
		answer.signature,
	);
	return advanceOffer(offerId);
}
