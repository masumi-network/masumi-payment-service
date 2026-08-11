/**
 * The lifecycle ordering the connection manager and its extracted operations
 * both reason about, kept apart from either so neither has to import the other.
 *
 * The rank is what makes "regressive" meaningful: a frame is only a rollback if
 * it ranks below what is already persisted.
 */

import { HydraHeadStatus } from '@/generated/prisma/client';

export const HYDRA_HEAD_STATUS_RANK: Record<HydraHeadStatus, number> = {
	[HydraHeadStatus.Disconnected]: 0,
	[HydraHeadStatus.Connected]: 0,
	[HydraHeadStatus.Connecting]: 0,
	[HydraHeadStatus.Idle]: 0,
	[HydraHeadStatus.Initializing]: 1,
	[HydraHeadStatus.Open]: 2,
	[HydraHeadStatus.Closed]: 3,
	[HydraHeadStatus.FanoutPossible]: 4,
	[HydraHeadStatus.Final]: 5,
};

export type LockedHydraHeadLifecycle = {
	id: string;
	hydraRelationId: string;
	isEnabled: boolean;
	status: HydraHeadStatus;
	headIdentifier: string | null;
	fanoutTxHash: string | null;
};

export type RegressiveStatusResult =
	| 'persisted'
	| 'quarantined-confirmed-finality-conflict'
	| 'quarantined-relation-conflict'
	| 'not-regressive'
	| 'ignored';
