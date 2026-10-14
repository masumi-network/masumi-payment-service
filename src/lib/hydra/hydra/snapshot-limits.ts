/**
 * Hydra's snapshot size limit, on its own so the KZG worker can load the
 * accumulator without the protocol schemas (zod, Prisma) behind it.
 */
export const MAX_HYDRA_SNAPSHOT_OUTPUTS = 4095;
