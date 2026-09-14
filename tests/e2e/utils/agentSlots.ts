import { PaymentSourceType } from '@/generated/prisma/enums';
import type { ConfirmedAgent } from '../helperFunctions';
import '../setup/globals';

/**
 * Pick the agent that a concurrently running flow file should use.
 *
 * `globalSetup` registers one agent per selling hot wallet. A source seeded
 * with a single selling wallet therefore hands every slot the same agent,
 * which is exactly what each flow file used before they ran concurrently. A
 * source seeded with several selling wallets gives the first N slots a wallet
 * each, and that is what lets concurrent flows overlap: V1 processes one
 * request per hot wallet per scheduler tick and holds the wallet locked until
 * the transaction confirms.
 *
 * The modulo keeps the mapping total. More flow files than wallets means some
 * flows share a wallet and pipeline, which is slower but still correct.
 */
export function pickAgentForSlot(sourceType: PaymentSourceType, slot: number): ConfirmedAgent {
	const agents = global.testAgents?.[sourceType] ?? [];
	if (agents.length === 0) {
		throw new Error(`No registered agent for ${sourceType}. globalSetup may have skipped this source type.`);
	}
	return agents[slot % agents.length];
}
