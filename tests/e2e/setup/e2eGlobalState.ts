import type { ConfirmedAgent } from '../helperFunctions';
import { Network } from '@/generated/prisma/enums';

export type E2EGlobalState = {
	network: Network;
	agent: ConfirmedAgent;
	createdAt: string;
};

export const E2E_GLOBAL_STATE_ENV_KEY = 'E2E_GLOBAL_STATE_B64';

export function encodeE2EGlobalState(state: E2EGlobalState): string {
	const json = JSON.stringify(state);
	return Buffer.from(json, 'utf8').toString('base64');
}

export function decodeE2EGlobalState(encoded: string): E2EGlobalState {
	const json = Buffer.from(encoded, 'base64').toString('utf8');
	return JSON.parse(json) as E2EGlobalState;
}
