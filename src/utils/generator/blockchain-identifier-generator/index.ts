import LZString from 'lz-string';
import { validateHexString } from '@/utils/validator/hex';

export type DecodedBlockchainIdentifier = {
	sellerId: string;
	purchaserId: string;
	signature: string;
	key: string;
	agentIdentifier: string | null;
	smartContractAddress: string | null;
};

export function generateBlockchainIdentifier(
	referenceKey: string,
	referenceSignature: string,
	sellerNonce: string,
	buyerNonce: string,
	smartContractAddress?: string | null,
): string {
	const segments = [sellerNonce, buyerNonce, referenceSignature, referenceKey];
	if (smartContractAddress != null) {
		segments.push(smartContractAddress);
	}
	const signedEncodedBlockchainIdentifier = Buffer.from(segments.join('.')).toString('utf-8');

	return Buffer.from(LZString.compressToUint8Array(signedEncodedBlockchainIdentifier)).toString('hex');
}

export function decodeBlockchainIdentifier(blockchainIdentifier: string): DecodedBlockchainIdentifier | null {
	const decompressed = LZString.decompressFromUint8Array(Buffer.from(blockchainIdentifier, 'hex'));
	if (typeof decompressed !== 'string') {
		return null;
	}

	const blockchainIdentifierSplit = decompressed.split('.');
	if (blockchainIdentifierSplit.length !== 4 && blockchainIdentifierSplit.length !== 5) {
		return null;
	}
	const sellerId = blockchainIdentifierSplit[0];
	if (validateHexString(sellerId) == false) {
		return null;
	}
	let agentIdentifier = null;
	if (sellerId.length > 64) {
		agentIdentifier = sellerId.slice(64);
	}
	const purchaserId = blockchainIdentifierSplit[1];
	if (validateHexString(purchaserId) == false) {
		return null;
	}
	const signature = blockchainIdentifierSplit[2];
	const key = blockchainIdentifierSplit[3];
	const smartContractAddress = blockchainIdentifierSplit.length === 5 ? blockchainIdentifierSplit[4] : null;
	if (smartContractAddress != null) {
		// Cardano bech32 addresses are ~108 chars; allow generous buffer.
		// Reject anything that does not start with 'addr' (covers 'addr_test1...'
		// and 'addr1...') to keep the optional 5th segment well-formed.
		if (smartContractAddress.length > 250 || !smartContractAddress.startsWith('addr')) {
			return null;
		}
	}
	return {
		sellerId: sellerId,
		purchaserId: purchaserId,
		signature: signature,
		key: key,
		agentIdentifier: agentIdentifier,
		smartContractAddress,
	};
}
