/**
 * Fanning out a chosen part of a closed head.
 *
 * hydra-node 2.4.1 accepts `PartialFanout` with any non-empty sub-multiset of
 * what the head still holds. The operator uses it to move every output that
 * fits out of a head that one output keeps from reaching Final, and then
 * retires the head (`retire.ts`). Once a step lands, the node accepts only
 * further `PartialFanout` commands; a plain Fanout fails. See ADR 0013.
 */

import { HydraErrorType, HydraHeadStatus } from '@/generated/prisma/client';
import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { z } from '@masumi/payment-core/zod';
import createHttpError from 'http-errors';

import {
	HYDRA_FANOUT_MODES,
	HydraFanoutHeadStateError,
	parseFanoutHeadState,
	type HydraFanoutHeadState,
	type HydraFanoutRemainingUtxo,
} from '@/lib/hydra/hydra/fanout-head-state';
import { MAX_HYDRA_SNAPSHOT_OUTPUTS } from '@/lib/hydra/hydra/snapshot-limits';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { recordHeadError } from '@/services/hydra-head-error/record';

import { lifecycleInput, lifecycleOutput } from './lifecycle';

const PARTIAL_FANOUT_STATUSES: ReadonlySet<HydraHeadStatus> = new Set([
	HydraHeadStatus.FanoutPossible,
	HydraHeadStatus.FanningOut,
]);

export const partialFanoutHeadInput = lifecycleInput.extend({
	outputRefs: z
		.array(z.string().regex(/^[0-9a-fA-F]{64}#\d{1,10}$/))
		.min(1)
		.max(MAX_HYDRA_SNAPSHOT_OUTPUTS)
		.describe('In-head references (txHash#index) of the outputs to fan out in this step'),
	replaceInProgressSelection: z
		.boolean()
		.optional()
		.describe('Send the selection even while the node fans out on its own; it replaces the selection in progress.'),
});

export const partialFanoutHeadOutput = lifecycleOutput.extend({
	selectedCount: z.number(),
});

type FanoutHeadStateSource = { get<T>(url: string): Promise<T> };

/**
 * What the head still holds, from the node's own head state: the same set the
 * node checks a selection against. See `fanout-head-state.ts`.
 */
export async function readFanoutHeadState(node: FanoutHeadStateSource): Promise<HydraFanoutHeadState> {
	let state: HydraFanoutHeadState | null;
	try {
		state = parseFanoutHeadState(await node.get('/head'));
	} catch (error) {
		if (error instanceof HydraFanoutHeadStateError) throw createHttpError(502, error.message);
		throw error;
	}
	if (!state) throw createHttpError(409, 'The Hydra node does not hold this head as closed');
	return state;
}

/**
 * In `AutoDrain` and `DistributingSelection` the node posts the next step on
 * its own. A new selection replaces the one in progress, and a retire stops
 * tracking a head that may still be settling. Both stay possible, because a
 * step that cannot post (an oversized output) leaves the node in that mode
 * for good: the caller says so explicitly with `override`.
 */
export function assertNodeAwaitsFanoutSelection(
	state: HydraFanoutHeadState,
	override: { allowed: boolean; flag: string },
): void {
	if (state.mode != null && state.mode !== 'AwaitingSelection' && !override.allowed) {
		throw createHttpError(
			409,
			`The Hydra node is still fanning out the head on its own (${state.mode}). Wait for it, or pass ${override.flag} ` +
				'once POST /hydra/head/chain-check shows the head output no longer moves',
		);
	}
}

/** The selection, keyed as the node reported it. Throws 409 for a reference it does not hold. */
export function selectFanoutOutputs(
	remaining: HydraFanoutRemainingUtxo,
	outputRefs: readonly string[],
): HydraFanoutRemainingUtxo {
	const byReference = new Map(Object.keys(remaining).map((reference) => [reference.toLowerCase(), reference]));
	const selection: HydraFanoutRemainingUtxo = {};
	const missing: string[] = [];
	for (const requested of outputRefs) {
		const reference = byReference.get(requested.toLowerCase());
		if (reference == null) missing.push(requested);
		else selection[reference] = remaining[reference]!;
	}
	if (missing.length > 0) {
		throw createHttpError(409, `The head does not hold these outputs any more: ${missing.join(', ')}`);
	}
	return selection;
}

export const fanoutRemainingOutput = lifecycleOutput.extend({
	fanoutMode: z
		.enum(HYDRA_FANOUT_MODES)
		.nullable()
		.describe('Null before the first step. A selection is accepted only before it or in AwaitingSelection.'),
	outputs: z.array(
		z.object({
			reference: z.string(),
			address: z.string(),
			lovelace: z.string(),
		}),
	),
});

/** Read-only: what a partial fanout can select from now. */
export const fanoutRemainingGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: lifecycleInput,
	output: fanoutRemainingOutput,
	handler: async ({ input }) => {
		const head = await prisma.hydraHead.findUnique({
			where: { id: input.headId },
			select: { id: true, status: true },
		});
		if (!head) throw createHttpError(404, 'Hydra head not found');
		if (!PARTIAL_FANOUT_STATUSES.has(head.status)) {
			throw createHttpError(409, `Head status is ${head.status}, expected FanoutPossible or FanningOut`);
		}
		const node = getHydraConnectionManager().getNode(head.id);
		if (!node) throw createHttpError(502, 'No active connection to Hydra head');

		const { mode, selectable } = await readFanoutHeadState(node);
		return {
			headId: head.id,
			status: head.status,
			fanoutMode: mode,
			outputs: Object.entries(selectable).map(([reference, output]) => {
				const lovelace = output.value.lovelace;
				// BigInt on the way in, string on the wire.
				return {
					reference,
					address: output.address,
					lovelace: typeof lovelace === 'bigint' ? lovelace.toString() : '0',
				};
			}),
		};
	},
});

export const partialFanoutHeadPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: partialFanoutHeadInput,
	output: partialFanoutHeadOutput,
	handler: async ({ input }) => {
		const head = await prisma.hydraHead.findUnique({ where: { id: input.headId } });
		if (!head) throw createHttpError(404, 'Hydra head not found');
		if (!head.isEnabled) throw createHttpError(409, 'Cannot fan out a disabled Hydra head');
		if (!PARTIAL_FANOUT_STATUSES.has(head.status)) {
			throw createHttpError(
				409,
				`Cannot fan out part of the head: status is ${head.status}, expected FanoutPossible or FanningOut`,
			);
		}

		const cm = getHydraConnectionManager();
		const hydraHead = cm.getHead(head.id);
		const node = cm.getNode(head.id);
		if (!hydraHead || !node) throw createHttpError(502, 'No active connection to Hydra head');

		const fanoutState = await readFanoutHeadState(node);
		assertNodeAwaitsFanoutSelection(fanoutState, {
			allowed: input.replaceInProgressSelection === true,
			flag: 'replaceInProgressSelection',
		});
		const remaining = fanoutState.selectable;
		const selection = selectFanoutOutputs(remaining, input.outputRefs);
		const selectedCount = Object.keys(selection).length;

		try {
			await hydraHead.partialFanout(selection);
			await cm.flushHeadStatus(head.id);
			const persistedHead = await prisma.hydraHead.findUnique({
				where: { id: head.id },
				select: { status: true },
			});
			if (!persistedHead) throw createHttpError(404, 'Hydra head not found');

			logger.info(`[HydraAPI] Head ${head.id} partial fanout step completed`, {
				status: persistedHead.status,
				selectedCount,
				remainingCount: Object.keys(remaining).length - selectedCount,
			});
			return { headId: head.id, status: persistedHead.status, selectedCount };
		} catch (error) {
			await recordHeadError(head.id, head.status, HydraErrorType.CommandFailed, error, 'PartialFanout');
			throw error;
		}
	},
});
