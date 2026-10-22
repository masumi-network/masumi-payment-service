/**
 * What a redemption attempt may do to the redeemer's own record.
 *
 * The record is the only evidence that the issuer's single-use nonce may have
 * been spent for us, so the cases that matter are the ones that delete it
 * (`discard`), end it (`fail`) or leave it (`keep`). Deleting it after a
 * redemption that landed burns the invite for both sides.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { readRefusal, type ExchangeAttempt } from './exchange-client';
import { advanceRedemption, type RedemptionPorts, type RedemptionState } from './redemption';

const issuerPeer = { advertise: 'issuer.example:5001', hydraVerificationKey: 'hvk', cardanoVerificationKey: 'cvk' };

function state(overrides: Partial<RedemptionState> = {}): RedemptionState {
	return { status: 'Redeemed', acknowledged: false, hostPaused: false, issuerPeer, ...overrides };
}

function ports(attempt: ExchangeAttempt, overrides: Partial<RedemptionPorts> = {}) {
	const fakes = {
		claim: jest.fn(async () => true),
		checkPeerTarget: jest.fn(async () => ({ supported: true, allowed: true, reason: null })),
		assertNoCompetingRedemption: jest.fn(async () => undefined),
		post: jest.fn(async () => attempt),
		markAcknowledged: jest.fn(async (): Promise<'Redeemed' | 'Started' | 'Completed' | null> => 'Redeemed'),
		discard: jest.fn(async () => undefined),
		fail: jest.fn(async () => true),
		currentPeers: jest.fn(async () => []),
		setPeers: jest.fn(async () => undefined),
		start: jest.fn(async () => undefined),
		markStarted: jest.fn(async () => true),
		createHead: jest.fn(async () => ({ hydraHeadId: 'head-1' })),
		reload: jest.fn(async () => null),
		...overrides,
	};
	return fakes as typeof fakes & RedemptionPorts;
}

const answered = (status: number, detail: string): ExchangeAttempt => ({
	kind: 'answered',
	status,
	...readRefusal(detail),
	detail,
});
const HOST_BUSY = answered(503, '{"error":"exchange is busy","code":"host-unavailable"}');
const GATEWAY_503 = answered(503, '<html>503 Service Unavailable</html>');
const LOST = { kind: 'unknown', reason: 'socket hang up', host: 'issuer.example' } as const;

describe('the first attempt, inside the request that recorded it', () => {
	const first = { rowIsNew: true };

	it.each([
		['the Host is busy', HOST_BUSY],
		['the signature is refused', answered(401, '{"error":"signature does not verify"}')],
		['the nonce is unknown', answered(404, '{"error":"no such invite"}')],
	])('deletes the record when %s, so the code can be tried again', async (_label, attempt) => {
		const fakes = ports(attempt);

		await expect(advanceRedemption(state(), fakes, first)).rejects.toThrow();
		expect(fakes.discard).toHaveBeenCalledTimes(1);
		expect(fakes.fail).not.toHaveBeenCalled();
	});

	// Regression: a load balancer answers 503 when its upstream fails mid-request,
	// which can follow a redemption the Host already stored.
	it.each([
		['a gateway answers 503', GATEWAY_503],
		['a gateway answers 503 with its own JSON error', answered(503, '{"error":"upstream timeout"}')],
		['the answer is lost', LOST],
		['a gateway answers 502', answered(502, 'bad gateway')],
	])('keeps the record when %s', async (_label, attempt) => {
		const fakes = ports(attempt);

		await expect(advanceRedemption(state(), fakes, first)).rejects.toThrow(/retry the same invite code/);
		expect(fakes.discard).not.toHaveBeenCalled();
		expect(fakes.fail).not.toHaveBeenCalled();
	});

	it('never sends a redemption its own Host would refuse to peer with', async () => {
		const fakes = ports(
			{ kind: 'accepted' },
			{
				checkPeerTarget: jest.fn(async () => ({ supported: true, allowed: false, reason: 'private address' })),
			},
		);

		await expect(advanceRedemption(state(), fakes, first)).rejects.toThrow(/has not been used/);
		expect(fakes.post).not.toHaveBeenCalled();
		expect(fakes.discard).toHaveBeenCalledTimes(1);
	});
});

describe('a later attempt, by a retry or the resume job', () => {
	const later = { rowIsNew: false };

	it('does not send when another caller changed the record since it was read', async () => {
		const fakes = ports({ kind: 'accepted' }, { claim: jest.fn(async () => false) });

		await expect(advanceRedemption(state(), fakes, later)).rejects.toMatchObject({ status: 409 });
		expect(fakes.post).not.toHaveBeenCalled();
	});

	it.each([
		['the invite expired unredeemed', answered(410, '{"error":"invite expired"}')],
		['someone else redeemed it', answered(409, '{"error":"invite already redeemed","code":"redeemed-by-other"}')],
	])('fails the record when %s', async (_label, attempt) => {
		const fakes = ports(attempt);

		await expect(advanceRedemption(state(), fakes, later)).rejects.toThrow();
		expect(fakes.fail).toHaveBeenCalledTimes(1);
		expect(fakes.discard).not.toHaveBeenCalled();
	});

	it.each([
		['the Host is busy', HOST_BUSY],
		['an older Host refuses without a code', answered(409, '{"error":"invite already redeemed"}')],
		['the answer is lost', LOST],
	])('keeps the record when %s, since an earlier attempt may have landed', async (_label, attempt) => {
		const fakes = ports(attempt);

		await expect(advanceRedemption(state(), fakes, later)).rejects.toThrow();
		expect(fakes.discard).not.toHaveBeenCalled();
		expect(fakes.fail).not.toHaveBeenCalled();
	});
});

describe('after the issuer acknowledged', () => {
	it('configures and starts the node, then creates the head', async () => {
		const fakes = ports({ kind: 'accepted' });

		await expect(advanceRedemption(state(), fakes, { rowIsNew: true })).resolves.toEqual({ hydraHeadId: 'head-1' });
		expect(fakes.markAcknowledged).toHaveBeenCalledTimes(1);
		expect(fakes.setPeers).toHaveBeenCalledWith([issuerPeer]);
		expect(fakes.start).toHaveBeenCalledTimes(1);
	});

	it('starts nothing when the record changed before the acknowledgement was stored', async () => {
		const fakes = ports({ kind: 'accepted' }, { markAcknowledged: jest.fn(async () => null) });

		await expect(advanceRedemption(state(), fakes, { rowIsNew: true })).rejects.toMatchObject({ status: 409 });
		expect(fakes.start).not.toHaveBeenCalled();
		expect(fakes.createHead).not.toHaveBeenCalled();
	});

	// Regression: a creator whose post answered late must not restart a node a
	// concurrent retry already started, and the operator may since have stopped.
	it('leaves the node alone when a concurrent caller already started it', async () => {
		const fakes = ports({ kind: 'accepted' }, { markAcknowledged: jest.fn(async () => 'Completed' as const) });

		await advanceRedemption(state(), fakes, { rowIsNew: true });
		expect(fakes.setPeers).not.toHaveBeenCalled();
		expect(fakes.start).not.toHaveBeenCalled();
	});

	it('reports the head a concurrent caller finished, even on a Host paused since', async () => {
		const fakes = ports(
			{ kind: 'accepted' },
			{
				markAcknowledged: jest.fn(async () => 'Completed' as const),
				reload: jest.fn(async () => ({ status: 'Completed', hydraHeadId: 'head-2' })),
			},
		);

		await expect(advanceRedemption(state({ hostPaused: true }), fakes, { rowIsNew: true })).resolves.toEqual({
			hydraHeadId: 'head-2',
		});
		expect(fakes.createHead).not.toHaveBeenCalled();
	});

	it('touches nothing on a paused Host', async () => {
		const fakes = ports({ kind: 'accepted' });

		await expect(
			advanceRedemption(state({ acknowledged: true, hostPaused: true }), fakes, { rowIsNew: false }),
		).rejects.toMatchObject({ status: 409 });
		expect(fakes.start).not.toHaveBeenCalled();
		expect(fakes.createHead).not.toHaveBeenCalled();
	});

	it('does not restart a node already marked started', async () => {
		const fakes = ports({ kind: 'accepted' });

		await advanceRedemption(state({ acknowledged: true, status: 'Started' }), fakes, { rowIsNew: false });
		expect(fakes.setPeers).not.toHaveBeenCalled();
		expect(fakes.start).not.toHaveBeenCalled();
		expect(fakes.createHead).toHaveBeenCalledTimes(1);
	});

	it('reports the head a concurrent finisher created', async () => {
		const fakes = ports(
			{ kind: 'accepted' },
			{
				createHead: jest.fn(async () => {
					throw new Error('the invite was adopted or discarded concurrently');
				}),
				reload: jest.fn(async () => ({ status: 'Completed', hydraHeadId: 'head-2' })),
			},
		);

		await expect(
			advanceRedemption(state({ acknowledged: true, status: 'Started' }), fakes, { rowIsNew: false }),
		).resolves.toEqual({ hydraHeadId: 'head-2' });
	});
});
