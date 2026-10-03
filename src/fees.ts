import { BASE_FEE_WEI, DEFAULT_FEE_BPS, MAX_FEE_BPS, requireCondition } from './constants.js';

export interface SendQuote { grossWei: bigint; feeWei: bigint; netWei: bigint; feeBps: number }

export function validateFeeBps(feeBps: number): void {
  requireCondition(Number.isInteger(feeBps) && feeBps >= 0 && feeBps <= MAX_FEE_BPS, 'INVALID_FEE', 'Withdrawal fee must be between 0 and 100 basis points.');
}

export function quoteSend(grossWei: bigint, feeBps = DEFAULT_FEE_BPS): SendQuote {
  validateFeeBps(feeBps);
  requireCondition(typeof grossWei === 'bigint' && grossWei > 0n, 'INVALID_AMOUNT', 'Enter a positive integer wei amount.');
  const feeWei = grossWei * BigInt(feeBps) / 10000n + BASE_FEE_WEI;
  const netWei = grossWei - feeWei;
  requireCondition(netWei > 0n, 'AMOUNT_BELOW_FEE', 'The send amount must exceed the withdrawal fee.');
  return { grossWei, feeWei, netWei, feeBps };
}

/** Decimal ETH conversion without floating point arithmetic or rounding. */
export function parseEtherExact(value: string): bigint {
  requireCondition(/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(value), 'INVALID_AMOUNT', 'Enter an ETH amount with at most 18 decimal places.');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
}

export function formatEtherExact(wei: bigint): string {
  requireCondition(typeof wei === 'bigint' && wei >= 0n, 'INVALID_AMOUNT', 'Expected nonnegative wei.');
  const whole = wei / 10n ** 18n;
  const fraction = (wei % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
