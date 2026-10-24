/**
 * Bound getaddrinfo work without changing how hydra-node resolves peer names.
 * dns.resolve4/resolve6 would skip /etc/hosts and other OS name sources, so a
 * public DNS answer could approve a name hydra-node dials as a private address.
 * Node's dns.lookup has no cancellation API. A timed-out lookup stays in this
 * map until it actually settles; retries share it and cannot queue more work.
 */

import { lookup } from 'node:dns/promises';
import type { PeerHostnameResolver } from './api/peer-allowlist.js';

type Address = { address: string; family: number };
type Waiter = { complete: (result: { addresses: readonly Address[] } | { error: unknown }) => void };
type PendingLookup = { waiters: Set<Waiter>; owners: Set<string> };

export class PeerResolverUnavailableError extends Error {}

function lookupFailure(error: unknown): unknown {
	if (error !== null && typeof error === 'object' && 'code' in error) {
		const code = error.code;
		if (code === 'EAI_AGAIN' || code === 'ETIMEOUT' || code === 'ETIMEDOUT') {
			return new PeerResolverUnavailableError('peer lookup temporarily unavailable');
		}
	}
	return error;
}

const MAX_PENDING_PEER_LOOKUPS = 16;
const MAX_PENDING_LOOKUP_OWNERS = 128;
const PEER_LOOKUP_TIMEOUT_MS = 3_000;

export function createBoundedPeerResolver(
	lookupHost: (hostname: string) => Promise<readonly Address[]> = async (hostname) =>
		await lookup(hostname, { all: true, verbatim: true }),
	limits: { maxPending?: number; maxOwners?: number; timeoutMs?: number } = {},
): PeerHostnameResolver {
	const maxPending = limits.maxPending ?? MAX_PENDING_PEER_LOOKUPS;
	const maxOwners = limits.maxOwners ?? MAX_PENDING_LOOKUP_OWNERS;
	const timeoutMs = limits.timeoutMs ?? PEER_LOOKUP_TIMEOUT_MS;
	const pending = new Map<string, PendingLookup>();
	const pendingByOwner = new Map<string, PendingLookup>();

	return async (hostname, signal, owner) => {
		if (signal?.aborted) throw new PeerResolverUnavailableError('peer lookup was aborted');
		const key = hostname.toLowerCase();
		let entry = pending.get(key);
		if (owner !== undefined && pendingByOwner.has(owner) && pendingByOwner.get(owner) !== entry) {
			throw new PeerResolverUnavailableError('peer resolver is busy');
		}
		if (owner !== undefined && !pendingByOwner.has(owner) && pendingByOwner.size >= maxOwners) {
			throw new PeerResolverUnavailableError('peer resolver is busy');
		}
		if (entry === undefined) {
			if (pending.size >= maxPending) throw new PeerResolverUnavailableError('peer resolver is busy');
			entry = { waiters: new Set<Waiter>(), owners: new Set<string>() };
			pending.set(key, entry);
			const current = entry;
			void Promise.resolve()
				.then(async () => await lookupHost(hostname))
				.then(
					(addresses) => settle({ addresses }),
					(error: unknown) => settle({ error }),
				);

			function settle(result: { addresses: readonly Address[] } | { error: unknown }): void {
				pending.delete(key);
				for (const owner of current.owners) pendingByOwner.delete(owner);
				const outcome = 'error' in result ? { error: lookupFailure(result.error) } : result;
				for (const waiter of current.waiters) waiter.complete(outcome);
				current.waiters.clear();
			}
		}
		if (owner !== undefined) {
			// Keep one signed invite on one OS job until it settles, even if the
			// client changes advertise after a timeout or disconnect.
			entry.owners.add(owner);
			pendingByOwner.set(owner, entry);
		}

		return await new Promise<readonly Address[]>((resolve, reject) => {
			const current = entry.waiters;
			const onAbort = () => finish({ error: new PeerResolverUnavailableError('peer lookup was aborted') });
			const waiter: Waiter = { complete: finish };
			const timer = setTimeout(
				() => finish({ error: new PeerResolverUnavailableError('peer lookup timed out') }),
				timeoutMs,
			);
			function finish(result: { addresses: readonly Address[] } | { error: unknown }): void {
				clearTimeout(timer);
				signal?.removeEventListener('abort', onAbort);
				current.delete(waiter);
				if ('error' in result) reject(result.error instanceof Error ? result.error : new Error('peer lookup failed'));
				else resolve(result.addresses);
			}
			current.add(waiter);
			signal?.addEventListener('abort', onAbort, { once: true });
			if (signal?.aborted) onAbort();
		});
	};
}
