import {
  createRobinhoodTestnetConfig,
  createZkApiClient,
  formatEtherExact,
  isDefiniteTransactionFailure,
  parseEtherExact,
} from '@zkapi/robinhood-sdk';
import type {
  Eip1193Provider,
  Progress,
  SendQuote,
  TransactionResult,
  ZkApiClient,
} from '@zkapi/robinhood-sdk';

/** Supply your compatible backend and the directory with the pinned artifacts. */
export function createBrowserClient(options: {
  origin: string;
  apiUrl: string;
  artifactBaseUrl: string;
  onProgress: (progress: Progress) => void;
  onSessionInvalidated: () => void;
}): ZkApiClient {
  return createZkApiClient(createRobinhoodTestnetConfig(options));
}

/** Call after the user picks a wallet and chooses to unlock. Does not submit. */
export async function connectAndReadBalance(client: ZkApiClient, provider: Eip1193Provider) {
  await client.connect(provider, { switchChain: true });
  const balance = await client.unlock();
  return {
    totalEth: formatEtherExact(balance.privateBalanceWei),
    spendableEth: formatEtherExact(balance.maxSpendableWei),
  };
}

/** Refresh before displaying this quote; then wait for an explicit Send click. */
export async function reviewSend(client: ZkApiClient, grossEth: string): Promise<SendQuote> {
  await client.sync();
  return client.quoteSend(parseEtherExact(grossEth));
}

/** Submits through the relay. Do not call until the recipient and quote are approved. */
export async function submitReviewedSend(client: ZkApiClient, recipient: string, quote: SendQuote): Promise<TransactionResult> {
  return client.send({ recipient, grossWei: quote.grossWei, expectedFeeBps: quote.feeBps });
}

/** Submits a wallet transaction and pays testnet gas; call only after user review. */
export async function submitDeposit(client: ZkApiClient, amountEth: string): Promise<TransactionResult> {
  return client.deposit(parseEtherExact(amountEth));
}

/** Resume saved public identifiers; never builds a replacement payment. */
export async function resumePending(client: ZkApiClient, pending: {
  kind: 'deposit' | 'send';
  transactionHash: string | null;
  requestId: string;
}): Promise<TransactionResult> {
  if (pending.transactionHash) {
    return client.waitForConfirmation(pending.transactionHash, { requestId: pending.requestId });
  }
  if (pending.kind === 'send') return client.retryRelay(pending.requestId);
  return { status: 'pending', transactionHash: null, requestId: pending.requestId };
}

/** Only this discriminator proves a submitted operation reached a terminal failure. */
export function hasDefiniteFailure(error: unknown): boolean {
  return isDefiniteTransactionFailure(error);
}

// Nothing connects, requests a signature, or submits when this module is imported.
// On teardown call client.disconnect(). Preserve public pending tracking separately.
