import LZString from 'lz-string';
import { validateHexString } from '../contract-generator';

export type DecodedBlockchainIdentifier = {
  sellerId: string;
  purchaserId: string;
  signature: string;
  key: string;
  agentIdentifier: string | null;
};

export function generateBlockchainIdentifier(
  referenceKey: string,
  referenceSignature: string,
  sellerNonce: string,
  buyerNonce: string,
): string {
  const signedEncodedBlockchainIdentifier = Buffer.from(
    sellerNonce +
      '.' +
      buyerNonce +
      '.' +
      referenceSignature +
      '.' +
      referenceKey,
  ).toString('utf-8');

  return Buffer.from(
    LZString.compressToUint8Array(signedEncodedBlockchainIdentifier),
  ).toString('hex');
}

export function decodeBlockchainIdentifier(
  blockchainIdentifier: string,
): DecodedBlockchainIdentifier | null {
  const decompressed = LZString.decompressFromUint8Array(
    Buffer.from(blockchainIdentifier, 'hex'),
  );
  if (typeof decompressed !== 'string') {
    return null;
  }

  const blockchainIdentifierSplit = decompressed.split('.');
  if (blockchainIdentifierSplit.length != 4) {
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
  return {
    sellerId: sellerId,
    purchaserId: purchaserId,
    signature: signature,
    key: key,
    agentIdentifier: agentIdentifier,
  };
}
