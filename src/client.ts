import { getAddress, Interface } from 'ethers';
import { HttpError, isDefiniteRelayRejection, ZkPayApi } from './api.js';
import { CHAIN_ID, requireCondition, TransactionFailedError, ZkPayError, ZERO_ADDRESS } from './constants.js';
import { quoteSend, validateFeeBps } from './fees.js';
import type { SendQuote } from './fees.js';
import { unlockKeys } from './keys.js';
import type { PrivateKeys } from './keys.js';
import { recoverNotes } from './notes.js';
import type { OwnedNote } from './notes.js';
import { loadArtifacts, prepareTransaction, proveTransaction, selectNotes } from './proof.js';
import type { LoadedArtifacts, PreparedTransaction, ProvedTransaction } from './proof.js';
import { MAX_AMOUNT, POOL_ABI, poolDomain, relayRequestId, validateAmount } from './protocol.js';
import { rebuildMerkleTree } from './tree.js';
import type { MerkleTree } from './tree.js';
import type { BalanceSnapshot, CommitmentRecord, ContractProof, ExternalData, PoolState, Progress, RelayResponse, SendRequest, TransactionResult, ZkPayClientApi, ZkPayConfig } from './types.js';
import { WalletSession } from './wallet.js';
import type { Eip1193Provider } from './wallet.js';

const poolInterface = new Interface(POOL_ABI);
interface Receipt { transactionHash: string; blockHash: string; blockNumber: string; to: string | null; status: string }
interface ChainTransaction { hash: string; to: string | null; value: string; blockHash: string | null; blockNumber: string | null; input?: string; data?: string }
interface PendingTransaction { requestId?: string; transactionHash: string | null; proved?: ProvedTransaction; quote?: SendQuote }
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ZkPayClient implements ZkPayClientApi {
  readonly config: Readonly<ZkPayConfig>;
  private readonly api: ZkPayApi;
  private session: WalletSession | null = null;
  private keys: PrivateKeys | null = null;
  private state: PoolState | null = null;
  private walletBalance = 0n;
  private notes: OwnedNote[] = [];
  private tree: MerkleTree | null = null;
  private generation = 0;
  private acting = false;
  private artifacts: Promise<LoadedArtifacts> | null = null;
  private pending: PendingTransaction | null = null;
  private minimumCheckpointBlock = 0;

  constructor(config: ZkPayConfig) {
    requireCondition(config.chainId === CHAIN_ID, 'WRONG_CHAIN', 'This SDK only supports Robinhood Chain Testnet (46630).');
    const poolAddress = getAddress(config.poolAddress), verifierAddress = getAddress(config.verifierAddress), relayerAddress = getAddress(config.relayerAddress);
    requireCondition(![poolAddress, verifierAddress, relayerAddress].includes(ZERO_ADDRESS) && Number.isSafeInteger(config.deploymentBlock) && config.deploymentBlock >= 0 && typeof config.artifactId === 'string' && config.artifactId.length > 0, 'INVALID_DEPLOYMENT', 'A complete pinned testnet deployment is required.');
    for (const artifact of [config.artifacts?.wasm, config.artifacts?.zkey, config.artifacts?.verificationKey]) {
      requireCondition(!!artifact && typeof artifact.url === 'string' && artifact.url.length > 0 && /^[0-9a-f]{64}$/i.test(artifact.sha256), 'INVALID_DEPLOYMENT', 'All independent proof artifact URLs and SHA-256 identities must be pinned.');
    }
    requireCondition(Number.isSafeInteger(config.confirmations ?? 2) && (config.confirmations ?? 2) >= 1 && (config.confirmations ?? 2) <= 64, 'INVALID_DEPLOYMENT', 'Receipt confirmations must be between 1 and 64.');
    const origin = config.origin ?? (typeof window !== 'undefined' ? window.location.origin : undefined);
    requireCondition(!!origin && new URL(origin).origin === origin && /^https?:\/\//.test(origin), 'INVALID_ORIGIN', 'Set the exact application origin for recovery key separation.');
    this.config = Object.freeze({ ...config, poolAddress, verifierAddress, relayerAddress, origin,
      artifacts: Object.freeze({ wasm: Object.freeze({ ...config.artifacts.wasm }), zkey: Object.freeze({ ...config.artifacts.zkey }), verificationKey: Object.freeze({ ...config.artifacts.verificationKey }) }),
    });
    this.api = new ZkPayApi(this.config);
  }

  private progress(progress: Progress): void { this.config.onProgress?.(progress); }
  private clearPrivateState(): void { this.keys = null; this.notes = []; this.tree = null; }
  private invalidateSession = (): void => {
    this.generation++; this.session?.disconnect(); this.session = null;
    this.clearPrivateState(); this.walletBalance = 0n;
    this.config.onSessionInvalidated?.();
  };
  private assertGeneration(generation: number): void {
    requireCondition(this.generation === generation, 'SESSION_CHANGED', 'Wallet session changed during this operation. Reconnect to continue.');
  }
  private requireSession(): WalletSession {
    requireCondition(this.session, 'WALLET_DISCONNECTED', 'Connect an EVM wallet first.');
    return this.session;
  }
  private requireKeys(): PrivateKeys {
    requireCondition(this.keys, 'BALANCE_LOCKED', 'Restore the private balance with your wallet signature first.');
    return this.keys;
  }
  async getState(): Promise<PoolState> { this.state = await this.api.state(); return this.state; }
  getSnapshot(): BalanceSnapshot {
    const ordered = [...this.notes].sort((a, b) => a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1);
    const total = ordered.reduce((sum, note) => sum + note.amount, 0n);
    const twoNotes = ordered.slice(0, 2).reduce((sum, note) => sum + note.amount, 0n);
    return { account: this.session?.account ?? null, unlocked: this.keys !== null, walletBalanceWei: this.walletBalance,
      privateBalanceWei: total, maxSpendableWei: twoNotes > MAX_AMOUNT ? MAX_AMOUNT : twoNotes, noteCount: this.notes.length, state: this.state };
  }
  private async refreshWalletBalance(): Promise<void> {
    const session = this.requireSession(), generation = this.generation;
    await session.assertActive();
    this.assertGeneration(generation);
    const result = await session.provider.request({ method: 'eth_getBalance', params: [session.account, 'latest'] });
    this.assertGeneration(generation);
    requireCondition(typeof result === 'string' && /^0x[0-9a-f]+$/i.test(result), 'RPC_ERROR', 'Wallet returned an invalid ETH balance.');
    this.walletBalance = BigInt(result);
  }
  private async assertOnChainDeployment(session: WalletSession): Promise<void> {
    const generation = this.generation;
    await session.assertActive();
    this.assertGeneration(generation);
    for (const [method, expected] of [['verifier', this.config.verifierAddress], ['poolDomain', poolDomain(this.config.poolAddress)]] as const) {
      const response = await session.provider.request({ method: 'eth_call', params: [{ to: this.config.poolAddress, data: poolInterface.encodeFunctionData(method) }, 'latest'] });
      this.assertGeneration(generation);
      requireCondition(typeof response === 'string', 'DEPLOYMENT_MISMATCH', 'Wallet could not verify the pinned pool deployment.');
      const [actual] = poolInterface.decodeFunctionResult(method, response);
      requireCondition(method === 'verifier' ? getAddress(actual) === expected : actual === expected, 'DEPLOYMENT_MISMATCH', 'Wallet provider reports a different pool verifier or domain.');
    }
  }
  async connect(provider: Eip1193Provider, options: { switchChain?: boolean } = {}): Promise<BalanceSnapshot> {
    this.progress({ phase: 'connecting' });
    await this.getState();
    this.disconnect();
    const generation = this.generation;
    const session = await WalletSession.connect(provider, { ...options, onInvalidate: () => { if (this.generation === generation) this.invalidateSession(); } });
    try { this.assertGeneration(generation); await this.assertOnChainDeployment(session); this.session = session; await this.refreshWalletBalance(); }
    catch (error) { session.disconnect(); if (this.session === session) this.session = null; throw error; }
    return this.getSnapshot();
  }
  async unlock(): Promise<BalanceSnapshot> {
    const session = this.requireSession(), generation = this.generation;
    const state = await this.getState();
    this.assertGeneration(generation);
    requireCondition(!state.indexing && state.checkpoint.blockNumber >= this.minimumCheckpointBlock, 'INDEXER_CATCHING_UP', 'The indexer is catching up. Refresh shortly before unlocking.');
    await this.assertOnChainDeployment(session);
    this.progress({ phase: 'signing' });
    const keys = await unlockKeys(session, { chainId: CHAIN_ID, poolAddress: this.config.poolAddress, origin: this.config.origin! });
    this.assertGeneration(generation);
    this.keys = keys;
    return this.sync();
  }
  async sync(): Promise<BalanceSnapshot> {
    const session = this.requireSession(), generation = this.generation;
    this.progress({ phase: 'syncing' });
    await session.assertActive();
    await this.refreshWalletBalance();
    // Full public snapshots deliberately make no request revealing an owned note.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const state = await this.getState();
        this.assertGeneration(generation);
        requireCondition(!state.indexing && state.checkpoint.blockNumber >= this.minimumCheckpointBlock, 'INDEXER_CATCHING_UP', 'The indexer is catching up. Refresh shortly.');
        if (!this.keys) return this.getSnapshot();
        if (state.closed || !state.initialized) { this.notes = []; this.tree = null; return this.getSnapshot(); }
        requireCondition(state.poolEpoch === state.checkpoint.poolEpoch, 'INDEXER_CATCHING_UP', 'The indexer is catching up with the current pool epoch. Try refresh shortly.');
        const records: CommitmentRecord[] = [], spent = new Set<string>();
        let from = 0, nullifierFrom = 0, hasMore = true;
        while (hasMore) {
          const page = await this.api.events(state.checkpoint, from, nullifierFrom);
          records.push(...page.commitments);
          page.nullifiers.forEach((record) => spent.add(record.nullifier));
          from = page.nextFrom; nullifierFrom = page.nextNullifierFrom; hasMore = page.hasMore;
          this.assertGeneration(generation);
        }
        requireCondition(from === state.checkpoint.nextIndex && nullifierFrom === state.checkpoint.nextNullifierIndex, 'INVALID_EVENTS', 'Incomplete public event snapshot.');
        const tree = rebuildMerkleTree(records, state.checkpoint.root);
        const notes = state.closed ? [] : await recoverNotes(this.keys, records, spent);
        this.assertGeneration(generation); await session.assertActive();
        this.assertGeneration(generation);
        this.tree = tree; this.notes = notes;
        return this.getSnapshot();
      } catch (error) {
        this.assertGeneration(generation);
        if (error instanceof ZkPayError && ['REORG_RESET', 'SNAPSHOT_EXPIRED'].includes(error.code) && attempt < 2) { this.notes = []; this.tree = null; continue; }
        throw error;
      }
    }
    throw new ZkPayError('SYNC_FAILED', 'Could not synchronize a stable public checkpoint.');
  }
  quoteSend(grossWei: bigint): SendQuote {
    requireCondition(this.state, 'STATE_REQUIRED', 'Load the current testnet fee before requesting a quote.');
    validateAmount(grossWei);
    return quoteSend(grossWei, this.state.feeBps);
  }
  private async runAction(work: (generation: number) => Promise<TransactionResult>): Promise<TransactionResult> {
    requireCondition(!this.acting, 'OPERATION_IN_PROGRESS', 'Another wallet operation is still in progress.');
    requireCondition(!this.pending, 'TRANSACTION_PENDING', 'Confirm the existing pending transaction before starting another.');
    this.requireKeys(); this.acting = true;
    try { return await work(this.generation); } finally { this.acting = false; }
  }
  private async prepareAction(generation: number): Promise<{ keys: PrivateKeys; tree: MerkleTree; state: PoolState }> {
    await this.sync(); this.assertGeneration(generation);
    const keys = this.requireKeys(), state = this.state;
    requireCondition(this.tree && state && state.initialized && !state.closed, 'POOL_CLOSED', 'The testnet pool is not open.');
    // A restored checkpoint must still be among the pool's 100 retained roots.
    const session = this.requireSession();
    const result = await session.provider.request({ method: 'eth_call', params: [{ to: this.config.poolAddress, data: poolInterface.encodeFunctionData('isKnownRoot', [this.tree.root]) }, 'latest'] });
    requireCondition(typeof result === 'string' && poolInterface.decodeFunctionResult('isKnownRoot', result)[0] === true, 'STALE_ROOT', 'The indexer checkpoint is no longer in the pool root history. Refresh after indexing catches up.');
    return { keys, tree: this.tree, state };
  }
  private async prove(prepared: PreparedTransaction): Promise<ProvedTransaction> {
    if (!this.artifacts) {
      this.progress({ phase: 'loading-artifacts' });
      this.artifacts = loadArtifacts(this.config.artifacts, this.api.fetcher).catch((error) => { this.artifacts = null; throw error; });
    }
    return proveTransaction(prepared, await this.artifacts, (progress) => this.progress(progress));
  }
  async deposit(amountWei: bigint): Promise<TransactionResult> {
    validateAmount(amountWei);
    return this.runAction(async (generation) => {
      const { keys, tree, state } = await this.prepareAction(generation);
      requireCondition(amountWei <= BigInt(state.depositLimitWei), 'DEPOSIT_LIMIT', 'Deposit amount exceeds the current pool limit.');
      requireCondition(amountWei < this.walletBalance, 'INSUFFICIENT_WALLET_BALANCE', 'The wallet needs enough ETH for the deposit and network gas.');
      const inputs = [...this.notes].sort((a, b) => a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1).slice(0, 2);
      this.progress({ phase: 'encrypting' });
      const prepared = await prepareTransaction({ keys, tree, inputNotes: inputs, extAmount: amountWei, fee: 0n });
      const proved = await this.prove(prepared);
      this.assertGeneration(generation);
      const latest = await this.getState();
      this.assertGeneration(generation);
      requireCondition(!latest.indexing, 'INDEXER_CATCHING_UP', 'The indexer is catching up. Refresh before submitting.');
      requireCondition(latest.initialized && !latest.closed && amountWei <= BigInt(latest.depositLimitWei) && latest.poolEpoch === state.poolEpoch, 'POOL_CHANGED', 'Pool configuration changed while generating the proof. Refresh and try again.');
      this.progress({ phase: 'awaiting-wallet' });
      const hash = await this.requireSession().sendTransaction({ to: this.config.poolAddress, data: poolInterface.encodeFunctionData('transact', [proved.proof, proved.extData]), value: amountWei });
      const requestId = relayRequestId(this.config.poolAddress, proved.proof, proved.extData);
      this.pending = { transactionHash: hash, proved, requestId };
      this.progress({ phase: 'confirming', transactionHash: hash, requestId });
      return this.waitForConfirmation(hash, { requestId });
    });
  }
  async send(input: SendRequest): Promise<TransactionResult> {
    validateAmount(input.grossWei);
    if (input.expectedFeeBps !== undefined) validateFeeBps(input.expectedFeeBps);
    const recipient = getAddress(input.recipient);
    requireCondition(recipient !== ZERO_ADDRESS && recipient !== this.config.poolAddress, 'INVALID_RECIPIENT', 'Enter a nonzero recipient address other than the pool.');
    return this.runAction(async (generation) => {
      const { keys, tree, state } = await this.prepareAction(generation);
      requireCondition(input.expectedFeeBps === undefined || input.expectedFeeBps === state.feeBps, 'FEE_CHANGED', 'The withdrawal fee changed. Review the refreshed quote before sending.');
      const quote = quoteSend(input.grossWei, state.feeBps);
      const inputNotes = selectNotes(this.notes, input.grossWei);
      this.progress({ phase: 'encrypting' });
      const prepared = await prepareTransaction({ keys, tree, inputNotes, extAmount: -quote.netWei, fee: quote.feeWei, recipient, feeRecipient: this.config.relayerAddress });
      const proved = await this.prove(prepared);
      this.assertGeneration(generation); await this.requireSession().assertActive();
      const latest = await this.getState();
      this.assertGeneration(generation);
      requireCondition(!latest.indexing, 'INDEXER_CATCHING_UP', 'The indexer is catching up. Refresh before submitting.');
      requireCondition(latest.initialized && !latest.closed && latest.feeBps === state.feeBps && latest.poolEpoch === state.poolEpoch, 'POOL_CHANGED', 'Pool configuration changed while generating the proof. Refresh and review the current fee.');
      const requestId = relayRequestId(this.config.poolAddress, proved.proof, proved.extData);
      this.pending = { transactionHash: null, proved, quote, requestId };
      this.progress({ phase: 'relaying', requestId });
      let relay: RelayResponse;
      try { relay = await this.api.relay(proved.proof, proved.extData); }
      catch (error) {
        if (isDefiniteRelayRejection(error)) { this.pending = null; throw new TransactionFailedError('RELAY_REJECTED', error.message, undefined, requestId); }
        return { status: 'pending', transactionHash: null, requestId, quote };
      }
      requireCondition(relay.requestId === requestId, 'RELAY_ID_MISMATCH', 'Relay returned a different request identity. Keep the original request ID for reconciliation.');
      this.pending.transactionHash = relay.transactionHash;
      return this.handleRelay(relay, quote);
    });
  }
  async sendMax(recipient: string, options: { expectedFeeBps?: number } = {}): Promise<TransactionResult> {
    await this.sync();
    return this.send({ grossWei: this.getSnapshot().maxSpendableWei, recipient, ...options });
  }
  private async handleRelay(relay: RelayResponse, quote?: SendQuote): Promise<TransactionResult> {
    this.pending = { ...this.pending, requestId: relay.requestId, transactionHash: relay.transactionHash, quote };
    if (relay.status === 'failed' && relay.transactionHash === null && ['PRE_SIGN_REJECTED', 'RELAY_INVARIANT', 'IDENTITY_MISMATCH'].includes(relay.error ?? '')) {
      this.pending = null;
      throw new TransactionFailedError('RELAY_FAILED', `The unsigned relay preparation was rejected (${relay.error}).`, undefined, relay.requestId);
    }
    // A failed label with a hash still requires independent canonical receipt
    // verification. Unknown failures and reorgs cannot release the pending lock.
    if (!relay.transactionHash) return { status: 'pending', transactionHash: null, requestId: relay.requestId, quote };
    return this.waitForConfirmation(relay.transactionHash, { requestId: relay.requestId });
  }
  async retryRelay(requestId: string): Promise<TransactionResult> {
    requireCondition(!this.pending?.requestId || this.pending.requestId === requestId, 'TRANSACTION_PENDING', 'A different relay request is still pending.');
    let relay: RelayResponse;
    try { relay = await this.api.relayStatus(requestId); }
    catch (error) {
      if (error instanceof HttpError && error.status === 404 && this.pending?.proved) {
        try { relay = await this.api.relay(this.pending.proved.proof, this.pending.proved.extData); }
        catch (resubmitError) {
          if (isDefiniteRelayRejection(resubmitError)) { this.pending = null; throw new TransactionFailedError('RELAY_REJECTED', resubmitError.message, undefined, requestId); }
          return { status: 'pending', transactionHash: this.pending.transactionHash, requestId, quote: this.pending.quote };
        }
      } else return { status: 'pending', transactionHash: this.pending?.transactionHash ?? null, requestId, quote: this.pending?.quote };
    }
    requireCondition(relay.requestId === requestId, 'RELAY_ID_MISMATCH', 'Relay returned a different request identity.');
    // The server reconciles or rebroadcasts its persisted exact signed transaction.
    if (this.pending) { this.pending.requestId = relay.requestId; this.pending.transactionHash = relay.transactionHash; }
    return this.handleRelay(relay, this.pending?.quote);
  }
  private async readReceipt(hash: string): Promise<Receipt | null> {
    if (this.session) {
      await this.session.assertActive();
      return await this.session.provider.request({ method: 'eth_getTransactionReceipt', params: [hash] }) as Receipt | null;
    }
    const chain = await this.api.rpc<string>('eth_chainId');
    requireCondition(BigInt(chain) === BigInt(CHAIN_ID), 'WRONG_CHAIN', 'Receipt provider is on the wrong chain.');
    return this.api.rpc<Receipt | null>('eth_getTransactionReceipt', [hash]);
  }
  private async readCanonicalBlock(number: string): Promise<{ hash: string } | null> {
    if (this.session) return await this.session.provider.request({ method: 'eth_getBlockByNumber', params: [number, false] }) as { hash: string } | null;
    return this.api.rpc<{ hash: string } | null>('eth_getBlockByNumber', [number, false]);
  }
  private async readBlockNumber(): Promise<bigint> {
    const result = this.session ? await this.session.provider.request({ method: 'eth_blockNumber' }) : await this.api.rpc<string>('eth_blockNumber');
    requireCondition(typeof result === 'string' && /^0x[0-9a-f]+$/i.test(result), 'INVALID_RESPONSE', 'Invalid receipt provider block number.');
    return BigInt(result);
  }
  private async assertReceiptTransaction(receipt: Receipt, requestId?: string): Promise<{ kind: 'deposit' | 'send'; recipient: string }> {
    const hash = receipt.transactionHash;
    const transaction = (this.session
      ? await this.session.provider.request({ method: 'eth_getTransactionByHash', params: [hash] })
      : await this.api.rpc<ChainTransaction | null>('eth_getTransactionByHash', [hash])) as ChainTransaction | null;
    requireCondition(transaction, 'RPC_ERROR', 'Pool transaction information is not available yet.');
    requireCondition(transaction.hash.toLowerCase() === hash.toLowerCase() && transaction.to && getAddress(transaction.to) === this.config.poolAddress && transaction.blockHash?.toLowerCase() === receipt.blockHash.toLowerCase() && transaction.blockNumber === receipt.blockNumber, 'INVALID_RECEIPT', 'Could not bind the receipt to its canonical pool transaction.');
    const data = transaction.input ?? transaction.data;
    requireCondition(typeof data === 'string' && typeof transaction.value === 'string' && /^0x[0-9a-f]+$/i.test(transaction.value), 'INVALID_RECEIPT', 'Pool transaction data is unavailable.');
    const decoded = poolInterface.parseTransaction({ data, value: transaction.value });
    requireCondition(decoded?.name === 'transact', 'INVALID_RECEIPT', 'The receipt belongs to a different pool operation.');
    const decodedExtAmount = BigInt(decoded.args[1].extAmount);
    requireCondition(decodedExtAmount !== 0n && BigInt(transaction.value) === (decodedExtAmount > 0n ? decodedExtAmount : 0n), 'INVALID_RECEIPT', 'The pool transaction ETH value does not match its external amount.');
    if (this.pending?.proved) {
      const expected = poolInterface.encodeFunctionData('transact', [this.pending.proved.proof, this.pending.proved.extData]);
      const extAmount = BigInt(this.pending.proved.extData.extAmount);
      requireCondition(data.toLowerCase() === expected.toLowerCase() && BigInt(transaction.value) === (extAmount > 0n ? extAmount : 0n), 'INVALID_RECEIPT', 'The receipt belongs to a different proof, payment, or deposit amount.');
    }
    if (requestId) {
      const p = decoded.args[0], e = decoded.args[1];
      const proof: ContractProof = {
        pA: [String(p.pA[0]), String(p.pA[1])], pB: [[String(p.pB[0][0]), String(p.pB[0][1])], [String(p.pB[1][0]), String(p.pB[1][1])]], pC: [String(p.pC[0]), String(p.pC[1])],
        root: String(p.root), inputNullifiers: [String(p.inputNullifiers[0]), String(p.inputNullifiers[1])], outputCommitments: [String(p.outputCommitments[0]), String(p.outputCommitments[1])],
        publicAmount: String(p.publicAmount), extDataHash: String(p.extDataHash), poolDomain: String(p.poolDomain),
      };
      const extData: ExternalData = { recipient: e.recipient, extAmount: String(e.extAmount), feeRecipient: e.feeRecipient, fee: String(e.fee), encryptedOutput1: e.encryptedOutput1, encryptedOutput2: e.encryptedOutput2 };
      const extAmount = BigInt(extData.extAmount);
      requireCondition(extAmount !== 0n && BigInt(transaction.value) === (extAmount > 0n ? extAmount : 0n) && relayRequestId(this.config.poolAddress, proof, extData).toLowerCase() === requestId.toLowerCase(), 'INVALID_RECEIPT', 'The successful pool transaction does not match this request.');
    }
    return decodedExtAmount > 0n ? { kind: 'deposit', recipient: '' } : { kind: 'send', recipient: getAddress(decoded.args[1].recipient) };
  }
  async waitForConfirmation(transactionHash: string, options: { timeoutMs?: number; requestId?: string } = {}): Promise<TransactionResult> {
    requireCondition(/^0x[0-9a-f]{64}$/i.test(transactionHash), 'INVALID_TRANSACTION', 'Invalid transaction hash.');
    requireCondition(!this.pending?.transactionHash || this.pending.transactionHash.toLowerCase() === transactionHash.toLowerCase(), 'TRANSACTION_PENDING', 'A different transaction is still pending.');
    const requestId = options.requestId ?? this.pending?.requestId;
    const quote = this.pending?.quote;
    const timeout = options.timeoutMs ?? this.config.confirmationTimeoutMs ?? 120000;
    const deadline = Date.now() + Math.max(timeout, 0);
    this.progress({ phase: 'confirming', transactionHash, requestId });
    do {
      let receipt: Receipt | null = null;
      try { receipt = await this.readReceipt(transactionHash); }
      catch (error) { if (error instanceof ZkPayError && ['WRONG_CHAIN', 'SESSION_CHANGED'].includes(error.code)) break; }
      if (receipt) {
        requireCondition(receipt.transactionHash.toLowerCase() === transactionHash.toLowerCase() && receipt.to !== null && getAddress(receipt.to) === this.config.poolAddress && /^0x[0-9a-f]+$/i.test(receipt.blockNumber) && /^0x[0-9a-f]{64}$/i.test(receipt.blockHash), 'INVALID_RECEIPT', 'Receipt does not match the submitted pool transaction.');
        let canonical = false;
        try {
          const [block, head] = await Promise.all([this.readCanonicalBlock(receipt.blockNumber), this.readBlockNumber()]);
          canonical = block?.hash.toLowerCase() === receipt.blockHash.toLowerCase() && head - BigInt(receipt.blockNumber) + 1n >= BigInt(this.config.confirmations ?? 2);
        } catch { /* An unavailable/reorganizing read provider keeps the transaction pending. */ }
        if (!canonical) {
          if (Date.now() >= deadline) break;
          await sleep(Math.min(this.config.confirmationPollMs ?? 2500, Math.max(1, deadline - Date.now())));
          continue;
        }
        requireCondition(receipt.status === '0x0' || receipt.status === '0x1', 'INVALID_RECEIPT', 'Receipt is missing execution status.');
        let verified: { kind: 'deposit' | 'send'; recipient: string };
        try { verified = await this.assertReceiptTransaction(receipt, requestId); }
        catch (error) {
          if (error instanceof ZkPayError && error.code === 'INVALID_RECEIPT') throw error;
          if (Date.now() >= deadline) break;
          await sleep(Math.min(this.config.confirmationPollMs ?? 2500, Math.max(1, deadline - Date.now())));
          continue;
        }
        if (receipt.status === '0x0') { this.pending = null; throw new TransactionFailedError('TRANSACTION_REVERTED', `Transaction ${transactionHash} reverted on chain.`, transactionHash, requestId); }
        const result: TransactionResult = { status: 'confirmed', transactionHash, requestId, blockNumber: Number(BigInt(receipt.blockNumber)), ...verified, quote };
        this.minimumCheckpointBlock = Math.max(this.minimumCheckpointBlock, result.blockNumber!);
        this.pending = null;
        this.progress({ phase: 'confirmed', transactionHash, requestId });
        // Confirmed payment success is independent from indexer refresh availability.
        try { if (this.session) await this.sync(); } catch { /* A later refresh can catch up. */ }
        return result;
      }
      if (Date.now() >= deadline) break;
      await sleep(Math.min(this.config.confirmationPollMs ?? 2500, Math.max(1, deadline - Date.now())));
    } while (Date.now() <= deadline);
    this.pending = { ...this.pending, transactionHash, requestId, quote };
    return { status: 'pending', transactionHash, requestId, quote };
  }
  disconnect(): void {
    this.generation++; this.session?.disconnect(); this.session = null;
    this.clearPrivateState(); this.walletBalance = 0n;
  }
}

export function createZkPayClient(config: ZkPayConfig): ZkPayClient { return new ZkPayClient(config); }
