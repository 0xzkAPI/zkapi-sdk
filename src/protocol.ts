import { AbiCoder, getAddress, Interface, keccak256, toUtf8Bytes } from 'ethers';
import { poseidon2 } from 'poseidon-lite/poseidon2';
import { poseidon3 } from 'poseidon-lite/poseidon3';
import { poseidon5 } from 'poseidon-lite/poseidon5';
import { CHAIN_ID, FIELD, field, requireCondition } from './constants.js';
import type { ContractProof, ExternalData } from './types.js';

export const TREE_DEPTH = 26;
export const MAX_AMOUNT = (1n << 120n) - 1n;
export const PROTOCOL_DOMAIN = keccak256(toUtf8Bytes('zkPay/Robinhood/Mainnet/v1/pool'));
export const EXT_DATA_DOMAIN = keccak256(toUtf8Bytes('zkPay/Robinhood/Mainnet/v1/ext-data'));
const abi = AbiCoder.defaultAbiCoder();

export function poolDomain(pool: string, chainId = CHAIN_ID): bigint {
  requireCondition(chainId === CHAIN_ID, 'WRONG_CHAIN', 'Unsupported pool chain.');
  return field(BigInt(keccak256(abi.encode(['bytes32', 'uint256', 'address'], [PROTOCOL_DOMAIN, chainId, getAddress(pool)]))));
}
export function publicKey(domain: bigint, secret: bigint): bigint { return poseidon3([1n, domain, secret]); }
export function commitment(domain: bigint, amount: bigint, pubkey: bigint, blinding: bigint): bigint { return poseidon5([2n, domain, amount, pubkey, blinding]); }
export function nullifier(domain: bigint, noteCommitment: bigint, secret: bigint, index: number): bigint { return poseidon5([3n, domain, noteCommitment, secret, BigInt(index)]); }
export function hashPair(left: bigint, right: bigint): bigint { return poseidon2([left, right]); }
export function extDataHash(pool: string, data: ExternalData): bigint {
  return field(BigInt(keccak256(abi.encode(
    ['bytes32', 'uint256', 'address', 'address', 'int256', 'address', 'uint256', 'bytes', 'bytes'],
    [EXT_DATA_DOMAIN, CHAIN_ID, getAddress(pool), getAddress(data.recipient), data.extAmount, getAddress(data.feeRecipient), data.fee, data.encryptedOutput1, data.encryptedOutput2],
  ))));
}
export function validateAmount(amount: bigint, allowZero = false): void {
  requireCondition(typeof amount === 'bigint' && amount >= (allowZero ? 0n : 1n) && amount <= MAX_AMOUNT, 'INVALID_AMOUNT', 'Amount must be integer wei in the protocol 120-bit range.');
}
export function validateScalar(value: bigint): void {
  requireCondition(typeof value === 'bigint' && value >= 0n && value < FIELD, 'INVALID_FIELD', 'Invalid field scalar.');
}
export const POOL_ABI = [
  'function transact((uint256[2] pA,uint256[2][2] pB,uint256[2] pC,uint256 root,uint256[2] inputNullifiers,uint256[2] outputCommitments,uint256 publicAmount,uint256 extDataHash,uint256 poolDomain) proof,(address recipient,int256 extAmount,address feeRecipient,uint256 fee,bytes encryptedOutput1,bytes encryptedOutput2) extData) payable',
  'function currentRoot() view returns (uint256)',
  'function isKnownRoot(uint256 root) view returns (bool)',
  'function spentNullifiers(uint256 nullifier) view returns (bool)',
  'function epoch() view returns (uint256)',
  'function verifier() view returns (address)',
  'function poolDomain() view returns (uint256)',
  'event CommitmentData(uint256 indexed index,uint256 commitment,bytes encryptedOutput)',
  'event NullifierSpent(uint256 indexed nullifier)',
];

/** Same normalized idempotency identity independently computed by the relay. */
export function relayRequestId(pool: string, proof: ContractProof, extData: ExternalData): string {
  const calldata = new Interface(POOL_ABI).encodeFunctionData('transact', [proof, extData]);
  return keccak256(abi.encode(['string', 'uint256', 'address', 'bytes'], ['zkPay/Robinhood/Mainnet/v1/relay', CHAIN_ID, getAddress(pool), calldata]));
}
