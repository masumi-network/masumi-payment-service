import type { InboxRegistryListRecord } from './queries';

export function serializeInboxRegistryEntry(item: InboxRegistryListRecord) {
	return {
		...item,
		sendFundingLovelace: item.sendFundingLovelace?.toString() ?? null,
		CurrentTransaction: item.CurrentTransaction
			? {
					...item.CurrentTransaction,
					fees: item.CurrentTransaction.fees?.toString() ?? null,
				}
			: null,
	};
}

export function serializeInboxRegistryEntriesResponse(entries: InboxRegistryListRecord[]) {
	return {
		Assets: entries.map(serializeInboxRegistryEntry),
	};
}
