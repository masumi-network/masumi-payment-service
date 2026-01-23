import { createDecipheriv } from 'crypto';

import { createCipheriv } from 'crypto';

import { scryptSync } from 'crypto';

import { randomBytes } from 'crypto';
import { CONFIG } from '@/utils/config';

function decrypt(secretEncrypted: string) {
  const secret = Buffer.from(secretEncrypted, 'hex');
  const salt = secret.subarray(0, 16);
  const iv = secret.subarray(16, 32);

  const password = CONFIG.ENCRYPTION_KEY;
  const key = scryptSync(password, salt, 32);
  const encryptedData = secret.subarray(32);

  const decryptionCipher = createDecipheriv('aes-256-cbc', key, iv);
  return decryptionCipher.update(encryptedData, undefined, 'utf8') + decryptionCipher.final('utf8');
}

function encrypt(secret: string) {
  const salt = randomBytes(16);
  const key = scryptSync(CONFIG.ENCRYPTION_KEY, salt, 32);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  return (
    salt.toString('hex') +
    iv.toString('hex') +
    cipher.update(secret, 'utf8', 'hex') +
    cipher.final('hex')
  );
}

export { encrypt, decrypt };
