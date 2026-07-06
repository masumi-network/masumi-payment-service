/**
 * Characterization test for the state-transition tables.
 *
 * `transition-matrix.fixture.json` pins the outcome of EVERY
 * (current action × new on-chain state) combination. It was captured from the
 * original switch-tree implementation, so any diff here is a behavior change.
 *
 * To make an INTENTIONAL transition change: edit transition-tables.ts, then
 * regenerate the fixture with
 *
 *   UPDATE_TRANSITION_FIXTURE=1 pnpm test -- src/utils/logic/state-transitions
 *
 * and review the fixture diff in the PR like any other behavior change.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OnChainState, PaymentAction, PurchasingAction } from '@/generated/prisma/client';
import { convertNewPaymentActionAndError, convertNewPurchasingActionAndError } from './index';

const fixturePath = join(process.cwd(), 'src/utils/logic/state-transitions/transition-matrix.fixture.json');

type Row = [string, string, string, string | null, string | null];

function buildMatrix<TAction extends string>(
	actions: TAction[],
	convert: (
		action: TAction,
		state: OnChainState,
	) => {
		action: string;
		errorNote: string | null;
		errorType: string | null;
	},
): Row[] {
	const rows: Row[] = [];
	for (const action of actions) {
		for (const state of Object.values(OnChainState)) {
			const result = convert(action, state);
			rows.push([action, state, result.action, result.errorNote, result.errorType]);
		}
	}
	return rows;
}

describe('state transitions (characterization)', () => {
	const payment = buildMatrix(Object.values(PaymentAction), convertNewPaymentActionAndError);
	const purchasing = buildMatrix(Object.values(PurchasingAction), convertNewPurchasingActionAndError);

	if (process.env.UPDATE_TRANSITION_FIXTURE) {
		it('regenerates the fixture', () => {
			writeFileSync(fixturePath, JSON.stringify({ payment, purchasing }, null, 1) + '\n');
			expect(true).toBe(true);
		});
		return;
	}

	const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
		payment: Row[];
		purchasing: Row[];
	};

	it('covers every payment action × on-chain state combination', () => {
		expect(payment.length).toBe(Object.values(PaymentAction).length * Object.values(OnChainState).length);
		expect(payment.length).toBe(fixture.payment.length);
	});

	it('covers every purchasing action × on-chain state combination', () => {
		expect(purchasing.length).toBe(Object.values(PurchasingAction).length * Object.values(OnChainState).length);
		expect(purchasing.length).toBe(fixture.purchasing.length);
	});

	it('payment transitions match the pinned fixture', () => {
		expect(payment).toEqual(fixture.payment);
	});

	it('purchasing transitions match the pinned fixture', () => {
		expect(purchasing).toEqual(fixture.purchasing);
	});
});
