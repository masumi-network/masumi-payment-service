import LZString from 'lz-string';
import { validateHexString } from '../contract-generator';

export function generateBlockchainIdentifier(
  referenceKey: string,
  referenceSignature: string,
  sellerNonce: string,
  buyerNonce: string,
) {
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

export function decodeBlockchainIdentifier(blockchainIdentifier: string) {
  const decompressedEncodedBlockchainIdentifier =
    LZString.decompressFromUint8Array(Buffer.from(blockchainIdentifier, 'hex'));
  const blockchainIdentifierSplit =
    decompressedEncodedBlockchainIdentifier.split('.');
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
