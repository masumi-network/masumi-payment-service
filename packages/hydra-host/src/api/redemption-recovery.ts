import type { ExchangeStore } from '../registry/exchange-store.js';
import type { SupervisorLogger } from '../supervisor/supervisor.js';
import { setPeers, type ProvisionDeps } from './provision.js';

/** Replay durable redemptions until the reserved node has its peer files. */
export function createRedemptionRecovery(
	exchange: ExchangeStore,
	deps: ProvisionDeps,
	logger: SupervisorLogger,
): () => Promise<void> {
	let running: Promise<void> | undefined;
	return () => {
		running ??= recover()
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				logger.error(`[exchange] redemption recovery failed: ${message}`);
			})
			.finally(() => {
				running = undefined;
			});
		return running;
	};

	async function recover(): Promise<void> {
		for (const invite of await exchange.listInvites()) {
			if (invite.redeemedAt === null || invite.redeemer === null) continue;
			try {
				const node = await deps.store.read(invite.hostNodeId);
				// Peers are persisted only after every key file is written. They
				// prove setup completed, including a crash before the handler returned.
				// Never replay a start or undo an operator's later stop/removal.
				if (node === null || node.removalRequested || node.state === 'Removing' || node.peers.length > 0) continue;
				await setPeers(
					invite.hostNodeId,
					[
						{
							advertise: invite.redeemer.advertise,
							hydraVerificationKey: invite.redeemer.hydraVerificationKey,
							cardanoVerificationKey: invite.redeemer.cardanoVerificationKey,
						},
					],
					deps,
					{ onlyIfUnconfigured: true },
				);
				// Escrow acknowledgment already set desired Running. Configuring
				// peers makes the reservation startable without changing that intent.
				await exchange.recordStartError(invite.nonce, null);
				logger.info(`[exchange] invite ${invite.nonce} peer setup completed for node ${invite.hostNodeId}`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logger.error(`[exchange] node ${invite.hostNodeId} peer setup failed: ${message}`);
				await exchange.recordStartError(invite.nonce, message).catch(() => undefined);
			}
		}
	}
}
