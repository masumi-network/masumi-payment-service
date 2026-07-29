/**
 * Stands in for the counterparty operator's payment service.
 *
 * Receives a head offer, verifies it was signed by the wallet the relation
 * expects (proving our outbound signing is correct), provisions its own node on
 * a Hydra Host, and answers with a signed acceptance. That is the full other
 * half of the handshake, which is otherwise untestable without a second
 * payment-service deployment.
 *
 * Test support only.
 */

import { createServer } from 'node:http';
import { MeshWallet, checkSignature } from '@meshsdk/core';
import stringify from 'canonical-json';
import { generateSHA256Hash } from '@/utils/crypto';
import { buildHydraHeadOfferPayload } from '@/services/hydra-handshake/offer-payload';
import { provisionNodeOnHost, acknowledgeEscrowOnHost } from '@/services/hydra-host/client';

const PORT = Number(process.env.STUB_PORT ?? 3011);
const HOST_URL = process.env.STUB_HOST_URL ?? 'http://127.0.0.1:18443';
const HOST_ADMIN_TOKEN = process.env.STUB_HOST_ADMIN_TOKEN ?? '';
const MNEMONIC = (process.env.STUB_MNEMONIC ?? '').split(' ').filter((word) => word.length > 0);
const OUR_ADVERTISE_HOST = process.env.STUB_ADVERTISE_HOST ?? 'hydra-peer.local';
/** The address the incoming offer must be signed by — i.e. the initiator's wallet. */
const EXPECT_SIGNER = process.env.STUB_EXPECT_SIGNER ?? '';

type Json = Record<string, unknown>;

async function readJson(stream: NodeJS.ReadableStream): Promise<Json> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) {
		chunks.push(chunk as Buffer);
	}
	return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json;
}

async function main(): Promise<void> {
	const wallet = new MeshWallet({ networkId: 0, key: { type: 'mnemonic', words: MNEMONIC } });
	const address = await wallet.getChangeAddress();
	console.log(`[stub] counterparty wallet ${address}`);

	const server = createServer((request, response) => {
		void (async () => {
			if (!request.url?.endsWith('/hydra/handshake/offer')) {
				response.writeHead(404).end('{}');
				return;
			}
			try {
				const body = await readJson(request);
				const offer = body.offer as Parameters<typeof buildHydraHeadOfferPayload>[0];
				const signature = body.signature as { signature: string; key: string };

				// Verify THEIR signature the way a real counterparty would: against the
				// wallet our relation records for them.
				const hashed = generateSHA256Hash(stringify(buildHydraHeadOfferPayload(offer)));
				const ok = await checkSignature(hashed, signature, EXPECT_SIGNER);
				console.log(`[stub] inbound offer nonce=${offer.nonce} signatureValid=${ok}`);
				if (!ok) {
					response.writeHead(401, { 'Content-Type': 'application/json' });
					response.end(JSON.stringify({ status: 'error', error: { message: 'bad signature' } }));
					return;
				}

				// Provision our own node, mirroring what the real acceptor does.
				const provisioned = await provisionNodeOnHost(HOST_URL, HOST_ADMIN_TOKEN, `stub-${offer.nonce}`, {
					contestationPeriodSeconds: offer.contestationPeriodSeconds,
					depositPeriodSeconds: offer.depositPeriodSeconds,
					unsyncedPeriodSeconds: offer.unsyncedPeriodSeconds,
				});
				if (provisioned.secrets !== null) {
					await acknowledgeEscrowOnHost(HOST_URL, HOST_ADMIN_TOKEN, provisioned.nodeId);
				}
				console.log(`[stub] provisioned node ${provisioned.nodeId} advertise=${provisioned.advertise}`);

				const ourOffer = {
					...offer,
					hydraVerificationKey: provisioned.hydraVerificationKey,
					cardanoVerificationKey: provisioned.cardanoVerificationKey,
					// Our own reachable endpoint, on the port the host allocated us.
					advertise: `${OUR_ADVERTISE_HOST}:${provisioned.peerPort}`,
				};
				const ourHash = generateSHA256Hash(stringify(buildHydraHeadOfferPayload(ourOffer)));
				const signed = await wallet.signData(ourHash, address);

				response.writeHead(200, { 'Content-Type': 'application/json' });
				response.end(
					JSON.stringify({
						status: 'success',
						data: { accepted: true, offer: ourOffer, signature: { signature: signed.signature, key: signed.key } },
					}),
				);
				console.log('[stub] answered with a signed acceptance');
			} catch (error) {
				console.error('[stub] failed:', (error as Error).message);
				response.writeHead(500, { 'Content-Type': 'application/json' });
				response.end(JSON.stringify({ status: 'error', error: { message: (error as Error).message } }));
			}
		})();
	});

	server.listen(PORT, '127.0.0.1', () => console.log(`[stub] listening on :${PORT}`));
}

void main();
