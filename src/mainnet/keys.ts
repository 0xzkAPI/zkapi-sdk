import { getAddress, getBytes, hexlify, keccak256, Signature, toUtf8Bytes, verifyMessage } from 'ethers';
import { CHAIN_ID, FIELD, PROTOCOL, requireCondition } from './constants.js';
import type { WalletSession } from './wallet.js';

export interface KeyDomain { origin: string; chainId: typeof CHAIN_ID; poolAddress: string; account: string }
export interface PrivateKeys { spendKey: bigint; encryptionKey: CryptoKey; identity: string; domain: Readonly<KeyDomain> }

export function normalizedDomain(domain: KeyDomain): KeyDomain {
  requireCondition(domain.chainId === CHAIN_ID, 'WRONG_CHAIN', 'Key derivation is limited to Robinhood Chain Mainnet.');
  const origin = new URL(domain.origin).origin;
  requireCondition(origin !== 'null' && origin === domain.origin && /^https?:\/\//.test(origin), 'INVALID_ORIGIN', 'Key origin must be an exact HTTP(S) origin.');
  return { origin, chainId: CHAIN_ID, poolAddress: getAddress(domain.poolAddress), account: getAddress(domain.account) };
}

export function signingMessage(input: KeyDomain): string {
  const domain = normalizedDomain(input);
  return [
    'zkPay private balance recovery — Robinhood Chain Mainnet',
    '',
    'Sign this message to derive your private balance recovery keys.',
    'This signature does not authorize a transaction or transfer ETH.',
    'Only sign on the trusted zkPay origin shown below.',
    '',
    `Protocol: ${PROTOCOL}`,
    `Origin: ${domain.origin}`,
    `Chain ID: ${domain.chainId}`,
    `Pool: ${domain.poolAddress}`,
    `Account: ${domain.account}`,
    'Key version: 1',
  ].join('\n');
}

/** Normalize ECDSA's malleable high-s representation before deriving keys. */
export function normalizeSignature(signature: string): string {
  const bytes = getBytes(signature);
  if (bytes.length === 64) return Signature.from(signature).serialized;
  requireCondition(bytes.length === 65, 'INVALID_SIGNATURE', 'Expected an EOA ECDSA signature.');
  const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const r = BigInt(hexlify(bytes.slice(0, 32)));
  let s = BigInt(hexlify(bytes.slice(32, 64)));
  let parity = bytes[64];
  if (parity === 27 || parity === 28) parity -= 27;
  requireCondition(parity <= 1 && r > 0n && r < order && s > 0n && s < order, 'INVALID_SIGNATURE', 'Invalid ECDSA signature values.');
  if (s > order / 2n) { s = order - s; parity ^= 1; }
  return Signature.from({ r: `0x${r.toString(16).padStart(64, '0')}`, s: `0x${s.toString(16).padStart(64, '0')}`, v: 27 + parity }).serialized;
}

export async function deriveKeys(input: KeyDomain, firstSignature: string, secondSignature: string): Promise<PrivateKeys> {
  const domain = normalizedDomain(input);
  const message = signingMessage(domain);
  const first = normalizeSignature(firstSignature);
  const second = normalizeSignature(secondSignature);
  requireCondition(getAddress(verifyMessage(message, first)) === domain.account && getAddress(verifyMessage(message, second)) === domain.account, 'SIGNER_MISMATCH', 'Recovery signature was not signed by the selected wallet account.');
  requireCondition(first === second, 'NONDETERMINISTIC_SIGNATURE', 'This wallet produces changing signatures and cannot safely restore this private balance. Use a deterministic EOA wallet.');
  const salt = getBytes(keccak256(toUtf8Bytes(`${PROTOCOL}:key-salt\n${message}`)));
  const material = await crypto.subtle.importKey('raw', Uint8Array.from(getBytes(first)), 'HKDF', false, ['deriveBits']);
  const derive = async (purpose: string) => new Uint8Array(await crypto.subtle.deriveBits({
    name: 'HKDF', hash: 'SHA-256', salt: Uint8Array.from(salt), info: Uint8Array.from(toUtf8Bytes(`${PROTOCOL}:${purpose}`)),
  }, material, 256));
  const spendKey = BigInt(hexlify(await derive('spend-key'))) % (FIELD - 1n) + 1n;
  const encryptionKey = await crypto.subtle.importKey('raw', Uint8Array.from(await derive('note-encryption-key')), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const identity = keccak256(toUtf8Bytes(`${PROTOCOL}:cache\n${message}`));
  return Object.freeze({ spendKey, encryptionKey, identity, domain: Object.freeze(domain) });
}

export async function unlockKeys(session: WalletSession, domain: Omit<KeyDomain, 'account'>): Promise<PrivateKeys> {
  const fullDomain = { ...domain, account: session.account };
  const message = signingMessage(fullDomain);
  const first = await session.signMessage(message);
  const second = await session.signMessage(message);
  return deriveKeys(fullDomain, first, second);
}
