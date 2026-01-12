import { Ed25519PublicKey } from '@meshsdk/core-cst';
import { Cbor, CborNegInt, CborMap, CborBytes } from '@harmoniclabs/cbor';

export function getPublicKeyFromCoseKey(cbor: string): Ed25519PublicKey | null {
  const decodedCoseKey = Cbor.parse(cbor) as CborMap;
  const publicKeyEntry = decodedCoseKey.map.find((value) => {
    const k = value.k;
    if (k instanceof CborNegInt) {
      return k.num === BigInt(-2);
    }
    return false;
  });

  if (publicKeyEntry) {
    const publicKeyBuffer = Buffer.from((publicKeyEntry.v as CborBytes).bytes);
    return Ed25519PublicKey.fromBytes(publicKeyBuffer);
  }

  return null;
}
