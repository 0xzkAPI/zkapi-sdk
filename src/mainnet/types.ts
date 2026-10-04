import type { Eip1193Provider } from './wallet.js';
import type { CHAIN_ID } from './constants.js';
import type { SendQuote } from './fees.js';

export interface ArtifactLocation { url: string; sha256: string }
export interface ProofArtifacts {
  wasm: ArtifactLocation;
  zkey: ArtifactLocation;
  verificationKey: ArtifactLocation;
}
export interface ZkPayConfig {
  chainId: typeof CHAIN_ID;
  poolAddress: string;
  verifierAddress: string;
  relayerAddress: string;
  deploymentBlock: number;
  artifactId: string;
  artifacts: ProofArtifacts;
  apiUrl?: string;
  /** Caller-owned JSON-RPC endpoint for network registration and wallet-free receipt reads. No default. */
  rpcUrl: string;
  /** Exact application origin, defaulting to window.location.origin in browsers. */
  origin?: string;
  fetch?: typeof globalThis.fetch;
  confirmationTimeoutMs?: number;
  /** Initial confirmation delay; exponential backoff caps at 10s (or this value if slower). */
  confirmationPollMs?: number;
  /** Required confirmations including the receipt block; defaults to 2. */
  confirmations?: number;
  onProgress?: (progress: Progress) => void;
  onSessionInvalidated?: () => void;
}
export type ProgressPhase = 'connecting' | 'signing' | 'syncing' | 'encrypting' | 'loading-artifacts' | 'proving' | 'awaiting-wallet' | 'relaying' | 'confirming' | 'confirmed';
export interface Progress { phase: ProgressPhase; transactionHash?: string; requestId?: string }
export interface PoolState {
  apiVersion: 'zkpay-robinhood-mainnet-v1';
  chainId: typeof CHAIN_ID;
  pool: string;
  verifier: string;
  relayer: string;
  deploymentBlock: number;
  root: string;
  nextIndex: number;
  feeBps: number;
  baseFeeWei: string;
  depositLimitWei: string;
  shutdownAt: number | null;
  closed: boolean;
  initialized: boolean;
  poolAuthority: string;
  upgradeAuthority: string;
  artifactId: string;
  checkpoint: EventCheckpoint;
  network: 'Robinhood Chain Mainnet';
  bootstrapAuthority: string;
  poolEpoch: number;
  poolDomain: string;
  indexing: boolean;
}
export interface EventCheckpoint {
  blockNumber: number;
  blockHash: string;
  epoch: string;
  poolEpoch: number;
  root: string;
  nextIndex: number;
  nextNullifierIndex: number;
}
export interface EventMetadata { blockNumber: number; blockHash: string; transactionHash: string; logIndex: number }
export interface CommitmentRecord extends EventMetadata { index: number; commitment: string; encryptedOutput: string }
export interface NullifierRecord extends EventMetadata { index: number; nullifier: string }
export interface EventPage {
  apiVersion: 'zkpay-robinhood-mainnet-v1'; chainId: typeof CHAIN_ID; pool: string;
  checkpoint: EventCheckpoint;
  commitments: CommitmentRecord[];
  nullifiers: NullifierRecord[];
  nextFrom: number;
  nextNullifierFrom: number;
  hasMore: boolean;
}
export interface BalanceSnapshot {
  account: string | null;
  unlocked: boolean;
  walletBalanceWei: bigint;
  privateBalanceWei: bigint;
  /** A proof consumes at most two notes. Normally equals privateBalanceWei. */
  maxSpendableWei: bigint;
  noteCount: number;
  state: PoolState | null;
}
export interface ContractProof {
  pA: [string, string]; pB: [[string, string], [string, string]]; pC: [string, string];
  root: string;
  inputNullifiers: [string, string];
  outputCommitments: [string, string];
  publicAmount: string;
  extDataHash: string;
  poolDomain: string;
}
export interface ExternalData {
  recipient: string; extAmount: string; feeRecipient: string; fee: string;
  encryptedOutput1: string; encryptedOutput2: string;
}
export interface RelayResponse {
  requestId: string;
  status: 'pending' | 'confirmed' | 'failed';
  transactionHash: string | null;
  error?: string;
}
export interface TransactionResult {
  status: 'confirmed' | 'pending';
  transactionHash: string | null;
  requestId?: string;
  /** Only present after successful on-chain receipt verification. */
  blockNumber?: number;
  /** Only present when confirmed; decoded from the verified on-chain calldata. */
  kind?: 'deposit' | 'send';
  /** Verified send recipient, or an empty string for a confirmed deposit. */
  recipient?: string;
  /** Same-session balance refresh reached the receipt block; avoids a duplicate UI sync. */
  balanceRefreshed?: boolean;
  quote?: SendQuote;
}
export interface SendRequest {
  grossWei: bigint;
  recipient: string;
  /** Fee shown when the user reviewed the quote; a changed fee requires review. */
  expectedFeeBps?: number;
}

/** Public front-end contract. createZkPayClient returns this implementation. */
export interface ZkPayClientApi {
  readonly config: Readonly<ZkPayConfig>;
  connect(provider: Eip1193Provider, options?: { switchChain?: boolean }): Promise<BalanceSnapshot>;
  unlock(): Promise<BalanceSnapshot>;
  sync(): Promise<BalanceSnapshot>;
  getSnapshot(): BalanceSnapshot;
  getState(): Promise<PoolState>;
  quoteSend(grossWei: bigint): SendQuote;
  deposit(amountWei: bigint): Promise<TransactionResult>;
  send(input: SendRequest): Promise<TransactionResult>;
  sendMax(recipient: string, options?: { expectedFeeBps?: number }): Promise<TransactionResult>;
  waitForConfirmation(transactionHash: string, options?: { timeoutMs?: number; requestId?: string }): Promise<TransactionResult>;
  retryRelay(requestId: string): Promise<TransactionResult>;
  disconnect(): void;
}
