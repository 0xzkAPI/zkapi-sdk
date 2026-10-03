export const CHAIN_ID = 46630 as const;
export const CHAIN_ID_HEX = '0xb626' as const;
export const PROTOCOL = 'zkpay-robinhood-testnet-v1' as const;
export const BASE_FEE_WEI = 550000000000000n;
export const DEFAULT_FEE_BPS = 20;
export const MAX_FEE_BPS = 100;
export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const EXPLORER_URL = 'https://explorer.testnet.chain.robinhood.com';
export const PUBLIC_RPC_URL = 'https://rpc.testnet.chain.robinhood.com';
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export class ZkPayError extends Error {
  constructor(public readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ZkPayError';
  }
}

export class TransactionFailedError extends ZkPayError {
  readonly definiteFailure = true;
  constructor(code: 'TRANSACTION_REVERTED' | 'RELAY_FAILED' | 'RELAY_REJECTED', message: string, public readonly transactionHash?: string, public readonly requestId?: string) { super(code, message); }
}
export function isDefiniteTransactionFailure(error: unknown): error is TransactionFailedError {
  return error instanceof TransactionFailedError;
}

export function requireCondition(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new ZkPayError(code, message);
}

export function field(value: bigint): bigint { return ((value % FIELD) + FIELD) % FIELD; }

export function parseUint(value: unknown, name: string): bigint {
  requireCondition(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value), 'INVALID_RESPONSE', `${name} must be a decimal integer string.`);
  return BigInt(value);
}

export function parseField(value: unknown, name: string): bigint {
  const result = parseUint(value, name);
  requireCondition(result < FIELD, 'INVALID_FIELD', `${name} is outside the scalar field.`);
  return result;
}
