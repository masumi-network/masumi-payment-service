// Colocated OpenAPI docs for this route area. When you add or change an
// endpoint here, update THIS file in the same PR. CI regenerates
// openapi-docs.json and fails on drift.
import {
	getGuardedHydraSchemaInput,
	getGuardedHydraSchemaOutput,
	postGuardedHydraDepositSchemaInput,
	postGuardedHydraDepositSchemaOutput,
	postGuardedHydraSubmitSchemaInput,
	postGuardedHydraSubmitSchemaOutput,
	postGuardedHydraWithdrawSchemaInput,
	postGuardedHydraWithdrawSchemaOutput,
} from '@/routes/api/wallet/guarded/hydra/schemas';
import { successResponse, type SwaggerRegistrarContext } from '@/utils/generator/swagger-generator/shared';

const hotWalletId = 'cmg1hotwallet000example';
const hydraHeadId = 'cmg1hydrahead00example';
const unsignedTx = '84a400818258200000';
const signedTx = '84a400818258200000a100818258200000';

const transferExample = {
	id: 'cmg1hydratransfer0example',
	direction: 'Deposit',
	status: 'Prepared',
	hydraHeadId,
	txHash: 'c'.repeat(64),
	walletUtxoRef: `${'d'.repeat(64)}#0`,
	signBefore: new Date('2026-10-12T12:10:00Z'),
	recoverableAt: new Date('2026-10-12T13:00:00Z'),
	submittedAt: null,
	confirmedAt: null,
	failureReason: null,
	createdAt: new Date('2026-10-12T12:00:00Z'),
};

const submitBody = (direction: string) => ({
	description: `The prepared ${direction} with the owner witness added`,
	content: {
		'application/json': {
			schema: postGuardedHydraSubmitSchemaInput.openapi({
				example: { transferId: transferExample.id, signedTx },
			}),
		},
	},
});

const prepareErrors = {
	401: { description: 'Unauthorized' },
	404: { description: 'Hot wallet not found, not guarded, or Hydra head not found' },
	502: { description: 'No connection to the Hydra head, or the node could not build the transaction' },
};

const submitErrors = {
	400: { description: 'signedTx is not valid, changes the prepared body, or lacks the owner witness' },
	401: { description: 'Unauthorized' },
	404: { description: 'Transfer not found' },
	409: { description: 'The transfer is not Prepared, or it expired before it was signed' },
	502: { description: 'No connection to the Hydra head' },
};

export function registerGuardedHydraPaths({ registry, apiKeyAuth }: SwaggerRegistrarContext) {
	const secured = [{ [apiKeyAuth.name]: [] }];
	registry.registerPath({
		method: 'get',
		path: '/wallet/guarded/hydra',
		description:
			'Returns where the guarded smart wallet of a hot wallet is now: L2 inside a connected Hydra head, L1 on chain, or Unknown when neither can be read. Includes the wallet datum and balance at that location and the most recent deposits and withdrawals.',
		summary: 'Get the Hydra location of a guarded wallet. (admin access required)',
		tags: ['wallet'],
		security: secured,
		request: { query: getGuardedHydraSchemaInput.openapi({ example: { hotWalletId } }) },
		responses: {
			200: successResponse('Guarded wallet location', getGuardedHydraSchemaOutput, {
				location: 'L2',
				hydraHeadId,
				walletUtxoRef: transferExample.walletUtxoRef,
				state: {
					lovelace: '200000000',
					periodLimitLovelace: '1000000000',
					spentInPeriodLovelace: '120000000',
					periodStart: new Date('2026-10-12T09:00:00Z'),
					periodLengthMs: '86400000',
					minBalanceLovelace: '5000000',
				},
				l1Error: null,
				transfers: [
					{
						...transferExample,
						status: 'Confirmed',
						submittedAt: new Date('2026-10-12T12:05:00Z'),
						confirmedAt: new Date('2026-10-12T12:08:00Z'),
					},
				],
			}),
			401: { description: 'Unauthorized' },
			404: { description: 'Hot wallet not found or not guarded' },
		},
	});
	registry.registerPath({
		method: 'post',
		path: '/wallet/guarded/hydra/deposit',
		description:
			'Prepares a deposit of the guarded smart wallet from L1 into an open Hydra head the hot wallet takes part in. Returns the transfer and an unsigned transaction. The owner signs it (partial sign) before signBefore and sends it to the deposit submit endpoint.',
		summary: 'Prepare a guarded wallet deposit into a Hydra head. (admin access required)',
		tags: ['wallet'],
		security: secured,
		request: {
			body: {
				description: 'The guarded hot wallet and the target head',
				content: {
					'application/json': {
						schema: postGuardedHydraDepositSchemaInput.openapi({ example: { hotWalletId, hydraHeadId } }),
					},
				},
			},
		},
		responses: {
			200: successResponse('Deposit prepared', postGuardedHydraDepositSchemaOutput, {
				transfer: transferExample,
				unsignedTx,
			}),
			...prepareErrors,
			409: {
				description:
					'The wallet is already in a head or cannot be read on L1, the head is not usable, or another transfer is open',
			},
		},
	});
	registry.registerPath({
		method: 'post',
		path: '/wallet/guarded/hydra/deposit/submit',
		description:
			'Checks the owner-signed deposit against the prepared transaction and submits it. The transfer becomes Submitted, or Failed with a failureReason when the node refuses it. The status endpoint shows when the wallet arrives in the head.',
		summary: 'Submit an owner-signed guarded wallet deposit. (admin access required)',
		tags: ['wallet'],
		security: secured,
		request: { body: submitBody('deposit') },
		responses: {
			200: successResponse('Deposit submitted', postGuardedHydraSubmitSchemaOutput, {
				transfer: { ...transferExample, status: 'Submitted', submittedAt: new Date('2026-10-12T12:05:00Z') },
			}),
			...submitErrors,
		},
	});
	registry.registerPath({
		method: 'post',
		path: '/wallet/guarded/hydra/withdraw',
		description:
			'Prepares a decommit of the guarded smart wallet from its Hydra head back to L1. The agent hot wallet already signed for the collateral. Returns the transfer and an unsigned transaction for the owner to sign and send to the withdraw submit endpoint.',
		summary: 'Prepare a guarded wallet withdraw from a Hydra head. (admin access required)',
		tags: ['wallet'],
		security: secured,
		request: {
			body: {
				description: 'The guarded hot wallet',
				content: {
					'application/json': {
						schema: postGuardedHydraWithdrawSchemaInput.openapi({ example: { hotWalletId } }),
					},
				},
			},
		},
		responses: {
			200: successResponse('Withdraw prepared', postGuardedHydraWithdrawSchemaOutput, {
				transfer: { ...transferExample, direction: 'Withdraw', recoverableAt: null },
				unsignedTx,
			}),
			...prepareErrors,
			409: {
				description:
					'The wallet is not in a connected head, the head is not usable, the hot wallet has no collateral in the head, or another transfer is open',
			},
		},
	});
	registry.registerPath({
		method: 'post',
		path: '/wallet/guarded/hydra/withdraw/submit',
		description:
			'Checks the owner-signed decommit against the prepared transaction and sends it to the head. The transfer becomes Submitted, or Failed with a failureReason when the head refuses it. The status endpoint shows when the wallet is back on L1.',
		summary: 'Submit an owner-signed guarded wallet withdraw. (admin access required)',
		tags: ['wallet'],
		security: secured,
		request: { body: submitBody('withdraw') },
		responses: {
			200: successResponse('Withdraw submitted', postGuardedHydraSubmitSchemaOutput, {
				transfer: {
					...transferExample,
					direction: 'Withdraw',
					status: 'Submitted',
					recoverableAt: null,
					submittedAt: new Date('2026-10-12T12:05:00Z'),
				},
			}),
			...submitErrors,
		},
	});
}
