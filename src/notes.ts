import { getBytes, hexlify, toUtf8Bytes } from 'ethers';
import { FIELD, PROTOCOL, parseField, parseUint, requireCondition } from './constants.js';
import type { PrivateKeys } from './keys.js';
import { commitment, nullifier, poolDomain, publicKey, validateAmount, validateScalar } from './protocol.js';
import type { CommitmentRecord } from './types.js';

export interface Note { amount: bigint; blinding: bigint; pubkey: bigint; commitment: bigint }
export interface OwnedNote extends Note { index: number; nullifier: bigint }

export function randomScalar(nonzero = false): bigint {
  while (true) {
    const value = BigInt(hexlify(crypto.getRandomValues(new Uint8Array(32))));
    if (value < FIELD && (!nonzero || value > 0n)) return value;
  }
}
export function createNote(keys: PrivateKeys, amount: bigint, blinding = randomScalar()): Note {
  validateAmount(amount, true);
  validateScalar(blinding);
  const domain = poolDomain(keys.domain.poolAddress);
  const pubkey = publicKey(domain, keys.spendKey);
  return { amount, blinding, pubkey, commitment: commitment(domain, amount, pubkey, blinding) };
}
function additionalData(keys: PrivateKeys, noteCommitment: bigint): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(toUtf8Bytes(`${PROTOCOL}:encrypted-note:v1:${keys.domain.chainId}:${keys.domain.poolAddress.toLowerCase()}:${noteCommitment}`));
}
/** Envelope = version byte 1 || 12-byte random IV || AES-256-GCM ciphertext/tag. */
export async function encryptNote(keys: PrivateKeys, note: Note): Promise<string> {
  const expected = createNote(keys, note.amount, note.blinding);
  requireCondition(note.commitment === expected.commitment && note.pubkey === expected.pubkey, 'INVALID_NOTE', 'Output note does not belong to this recovery key.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = toUtf8Bytes(JSON.stringify({ v: 1, a: note.amount.toString(), b: note.blinding.toString(), p: note.pubkey.toString() }));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: additionalData(keys, note.commitment), tagLength: 128 }, keys.encryptionKey, Uint8Array.from(plaintext)));
  const envelope = new Uint8Array(13 + ciphertext.length);
  envelope[0] = 1; envelope.set(iv, 1); envelope.set(ciphertext, 13);
  requireCondition(envelope.length <= 1024, 'INVALID_NOTE', 'Encrypted note exceeds the protocol limit.');
  return hexlify(envelope);
}

/** Authentication failure simply means the public output is not recoverable by this wallet. */
export async function decryptNote(keys: PrivateKeys, encryptedOutput: string, expectedCommitment: bigint): Promise<Note | null> {
  if (!/^0x(?:[0-9a-f]{2})*$/i.test(encryptedOutput)) return null;
  const bytes = getBytes(encryptedOutput);
  if (bytes.length < 30 || bytes.length > 1024 || bytes[0] !== 1) return null;
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Uint8Array.from(bytes.slice(1, 13)), additionalData: additionalData(keys, expectedCommitment), tagLength: 128 }, keys.encryptionKey, Uint8Array.from(bytes.slice(13)));
  } catch { return null; }
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
  requireCondition(!!parsed && typeof parsed === 'object', 'INVALID_NOTE', 'Authenticated note payload is invalid.');
  const data = parsed as Record<string, unknown>;
  requireCondition(data.v === 1, 'INVALID_NOTE', 'Unsupported note version.');
  const note = createNote(keys, parseUint(data.a, 'note amount'), parseField(data.b, 'note blinding'));
  requireCondition(parseField(data.p, 'note pubkey') === note.pubkey && note.commitment === expectedCommitment, 'INVALID_NOTE', 'Authenticated note commitment does not match its event.');
  return note;
}

export async function recoverNotes(keys: PrivateKeys, records: readonly CommitmentRecord[], spentNullifiers: ReadonlySet<string>): Promise<OwnedNote[]> {
  const result: OwnedNote[] = [];
  const domain = poolDomain(keys.domain.poolAddress);
  for (const record of records) {
    const note = await decryptNote(keys, record.encryptedOutput, parseField(record.commitment, 'commitment'));
    if (!note || note.amount === 0n) continue;
    const spent = nullifier(domain, note.commitment, keys.spendKey, record.index);
    if (!spentNullifiers.has(spent.toString())) result.push({ ...note, index: record.index, nullifier: spent });
  }
  return result;
}
