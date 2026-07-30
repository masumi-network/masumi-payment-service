import { RegistryEntryType } from '@prisma/client';

/**
 * Maps a {@link RegistryEntryType} to the string emitted in the on-chain `721`
 * registry metadata `type` field. Standard maps to `undefined` on purpose: the
 * Standard record emits NO `type` key at all, so its metadata stays
 * byte-identical to entries minted before the type discriminator existed and
 * an absent `type` reads back as Standard (see {@link registryEntryTypeFromOnChain}).
 *
 * The on-chain strings intentionally differ from the enum identifiers
 * (`OpenAPI` not `OpenApi`, `x402V1` not `X402`) so the wire format is
 * self-describing and independently versioned from the DB representation.
 */
export const REGISTRY_ENTRY_ON_CHAIN_TYPE: Record<RegistryEntryType, string | undefined> = {
	[RegistryEntryType.Standard]: undefined,
	[RegistryEntryType.OpenApi]: 'OpenAPI',
	[RegistryEntryType.X402]: 'x402V1',
};

const ON_CHAIN_TO_ENTRY_TYPE: Record<string, RegistryEntryType> = {
	OpenAPI: RegistryEntryType.OpenApi,
	x402V1: RegistryEntryType.X402,
};

/**
 * Resolves the on-chain `type` string (possibly absent) back to a
 * {@link RegistryEntryType}. An absent or unrecognised value resolves to
 * `Standard` so legacy/untyped entries — and any future type an older indexer
 * does not know — degrade to the base standard shape rather than being dropped.
 */
export function registryEntryTypeFromOnChain(onChainType: string | string[] | undefined): RegistryEntryType {
	const value = Array.isArray(onChainType) ? onChainType.join('') : onChainType;
	if (value == null) return RegistryEntryType.Standard;
	return ON_CHAIN_TO_ENTRY_TYPE[value] ?? RegistryEntryType.Standard;
}
