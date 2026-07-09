import createHttpError from 'http-errors';
import { x402Client } from '@x402/core/client';
import { x402Facilitator } from '@x402/core/facilitator';
import { HTTPFacilitatorClient } from '@x402/core/http';
import type { Network } from '@x402/core/types';
import { toClientEvmSigner, toFacilitatorEvmSigner } from '@x402/evm';
import { registerExactEvmScheme as registerExactEvmClientScheme } from '@x402/evm/exact/client';
import { registerExactEvmScheme as registerExactEvmFacilitatorScheme } from '@x402/evm/exact/facilitator';
import { X402EvmWalletType } from '@masumi/payment-core/db';
import { decrypt } from '@masumi/payment-core/encryption';
import { createPublicClient, createWalletClient, publicActions } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
	assertRpcServesDeclaredChain,
	createChain,
	getEip155ChainId,
	getManagedWalletWithSecretOrThrow,
	getX402NetworkOrThrow,
	safeHttpTransport,
	type PrivateKey,
} from './internal';

// Build a signing client for an outbound payment. The wallet is bound to exactly one payment
// source, so we refuse to sign on any chain other than the one it was provisioned for — this
// is the constraint that replaces the previous "any Purchasing wallet, any chain" free-for-all.
export async function getClientForWallet(walletId: string, caip2Network: string) {
	const [wallet, network] = await Promise.all([
		getManagedWalletWithSecretOrThrow(walletId, X402EvmWalletType.Purchasing),
		getX402NetworkOrThrow(caip2Network),
	]);
	if (wallet.networkId !== network.id) {
		throw createHttpError(400, 'Managed wallet is not bound to the requested x402 network');
	}
	const privateKey = decrypt(wallet.Secret.encryptedPrivateKey) as PrivateKey;
	const account = privateKeyToAccount(privateKey);
	const chain = createChain(network.caip2Id, network.rpcUrl, network.displayName);
	const publicClient = createPublicClient({ chain, transport: safeHttpTransport(network.rpcUrl) });
	await assertRpcServesDeclaredChain(publicClient, network.caip2Id);
	const signer = toClientEvmSigner(account, publicClient);
	const client = new x402Client();
	const chainId = getEip155ChainId(network.caip2Id);

	registerExactEvmClientScheme(client, {
		signer,
		networks: [network.caip2Id as Network],
		schemeOptions: {
			[chainId]: { rpcUrl: network.rpcUrl },
		},
	});

	return {
		client,
		network,
		wallet,
		payer: account.address,
	};
}

type ResolvedNetwork = Awaited<ReturnType<typeof getX402NetworkOrThrow>>;

// Both the local x402Facilitator and the remote HTTPFacilitatorClient expose the verify/settle
// surface the settle/verify flows use; this union is the common shape returned by the resolver.
export type X402SettlingFacilitator = x402Facilitator | HTTPFacilitatorClient;

// Resolve a facilitator for a network in one of two modes, returning it alongside the resolved
// network (its id pins the attempt's rail):
//   - remote (facilitatorUrl): verify/settle are delegated over HTTP; the node owns no key.
//   - self-hosted (facilitatorWalletId): an owned Selling wallet signs settlements locally.
export async function getFacilitatorForNetwork(
	caip2Network: string,
): Promise<{ facilitator: X402SettlingFacilitator; network: ResolvedNetwork }> {
	const network = await getX402NetworkOrThrow(caip2Network);

	// Remote facilitator takes precedence: no owned wallet is required or expected here.
	if (network.facilitatorUrl != null) {
		const authEnc = network.facilitatorAuthEnc;
		const facilitator = new HTTPFacilitatorClient({
			url: network.facilitatorUrl,
			...(authEnc != null
				? {
						createAuthHeaders: async () => {
							// The stored value is the full Authorization header value, encrypted at rest.
							const headers = { Authorization: decrypt(authEnc) };
							return { verify: headers, settle: headers, supported: headers };
						},
					}
				: {}),
		});
		return { facilitator, network };
	}

	if (network.FacilitatorWallet == null) {
		throw createHttpError(400, 'x402 network has no facilitator configured');
	}
	// A retired (soft-deleted) facilitator key must never sign settlements, even if it is
	// still attached to the network (e.g. re-assigned after deletion).
	if (network.FacilitatorWallet.deletedAt != null) {
		throw createHttpError(400, 'x402 network facilitator wallet has been retired');
	}
	// Defense-in-depth: a facilitator settles inbound payments, so it must be a Selling
	// wallet. Assignment is already gated in upsertX402Network, but enforce at use too in
	// case a wallet's role changed after it was wired up.
	if (network.FacilitatorWallet.type !== X402EvmWalletType.Selling) {
		throw createHttpError(400, 'x402 network facilitator wallet is not a Selling wallet');
	}

	const privateKey = decrypt(network.FacilitatorWallet.Secret.encryptedPrivateKey) as PrivateKey;
	const account = privateKeyToAccount(privateKey);
	const chain = createChain(network.caip2Id, network.rpcUrl, network.displayName);
	const walletClient = createWalletClient({ account, chain, transport: safeHttpTransport(network.rpcUrl) }).extend(
		publicActions,
	);
	await assertRpcServesDeclaredChain(walletClient, network.caip2Id);
	const facilitatorSigner = toFacilitatorEvmSigner(
		Object.assign(walletClient, {
			address: account.address,
		}) as Parameters<typeof toFacilitatorEvmSigner>[0],
	);
	const facilitator = new x402Facilitator();

	registerExactEvmFacilitatorScheme(facilitator, {
		signer: facilitatorSigner,
		networks: network.caip2Id as Network,
	});

	return { facilitator, network };
}
