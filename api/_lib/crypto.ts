import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

function key(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error('Missing ENCRYPTION_KEY env var');
  // Accept any length; derive 32-byte key via SHA-256.
  return createHash('sha256').update(raw).digest();
}

const ALG = 'aes-256-gcm';

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

export function decrypt(payload: string): string {
  const parts = payload.split('.');
  if (parts.length !== 3) throw new Error('Invalid ciphertext');
  const [ivB, tagB, encB] = parts;
  const iv = Buffer.from(ivB, 'base64url');
  const tag = Buffer.from(tagB, 'base64url');
  const enc = Buffer.from(encB, 'base64url');
  const decipher = createDecipheriv(ALG, key(), iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}
