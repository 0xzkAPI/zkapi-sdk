import { getAddress } from 'ethers';
import { validateRpcUrl } from './rpc.js';
import { BASE_FEE_WEI, CHAIN_ID, parseField, parseUint, requireCondition, ZkPayError } from './constants.js';
import { validateFeeBps } from './fees.js';
import { MAX_AMOUNT, poolDomain, TREE_DEPTH } from './protocol.js';
import type { ContractProof, EventCheckpoint, EventPage, ExternalData, PoolState, RelayResponse, ZkPayConfig } from './types.js';

export const API_VERSION = 'zkpay-robinhood-mainnet-v1' as const;
export class HttpError extends ZkPayError {
  constructor(code: string, message: string, public readonly status: number) { super(code, message); }
}
/** Only explicit Worker validation responses prove that no transaction was accepted. */
export function isDefiniteRelayRejection(error: unknown): error is HttpError {
  if (!(error instanceof HttpError)) return false;
  const accepted: Record<number, readonly string[]> = {
    400: ['INVALID_INPUT', 'INVALID_JSON', 'WRONG_CHAIN', 'WRONG_POOL', 'WITHDRAWALS_ONLY', 'FEE_RECIPIENT', 'DOMAIN_MISMATCH', 'EXTERNAL_DATA_MISMATCH', 'PUBLIC_AMOUNT_MISMATCH'],
    403: ['ORIGIN_DENIED'],
    409: ['POOL_UNAVAILABLE', 'INCORRECT_FEE'],
    413: ['BODY_LIMIT'],
    415: ['CONTENT_TYPE', 'CONTENT_ENCODING'],
    422: ['INVALID_PROOF', 'SIMULATION_FAILED', 'GAS_LIMIT'],
  };
  return accepted[error.status]?.includes(error.code) === true;
}
function addressEqual(actual: unknown, expected: string, name: string): void {
  requireCondition(typeof actual === 'string' && getAddress(actual) === getAddress(expected), 'DEPLOYMENT_MISMATCH', `Backend ${name} differs from the pinned mainnet deployment.`);
}
function integer(value: unknown, name: string, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  requireCondition(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max, 'INVALID_RESPONSE', `Invalid ${name}.`);
}
export function validateCheckpoint(checkpoint: EventCheckpoint): void {
  requireCondition(!!checkpoint && typeof checkpoint === 'object', 'INVALID_RESPONSE', 'Missing indexer checkpoint.');
  integer(checkpoint.blockNumber, 'checkpoint block');
  integer(checkpoint.nextIndex, 'checkpoint leaf index', 2 ** TREE_DEPTH);
  integer(checkpoint.nextNullifierIndex, 'checkpoint nullifier index');
  integer(checkpoint.poolEpoch, 'pool epoch');
  requireCondition(/^\d+:\d+$/.test(checkpoint.epoch) && /^0x[0-9a-f]{64}$/i.test(checkpoint.blockHash), 'INVALID_RESPONSE', 'Invalid checkpoint identity.');
  parseField(checkpoint.root, 'checkpoint root');
}

export class ZkPayApi {
  readonly fetcher: typeof globalThis.fetch;
  readonly baseUrl: string;
  private readonly rpcUrl: string;
  private rpcId = 0;
  constructor(readonly config: Readonly<ZkPayConfig>) {
    this.rpcUrl = validateRpcUrl(config.rpcUrl);
    this.fetcher = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = (config.apiUrl ?? '/api/hood').replace(/\/$/, '');
  }
  private async request<T>(path: string, body?: unknown, rpc = false): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await this.fetcher(rpc ? this.rpcUrl : `${this.baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal,
      });
      const text = await response.text();
      requireCondition(text.length <= 3 * 1024 * 1024, 'INVALID_RESPONSE', 'API response is too large.');
      let data;
      try { data = JSON.parse(text); }
      catch { if (rpc) throw new HttpError('RPC_ERROR', 'The configured RPC returned an invalid response.', response.ok ? 503 : response.status); throw new HttpError('INVALID_RESPONSE', 'The mainnet service is temporarily unavailable. Check pending payments before retrying.', response.status); }
      if (rpc && !response.ok) throw new HttpError('RPC_ERROR', 'The configured RPC is unavailable. Keep any payment pending until verified.', response.status);
      if (!response.ok) throw new HttpError(typeof data?.error?.code === 'string' ? data.error.code : 'API_ERROR', typeof data?.error?.message === 'string' ? data.error.message : `Mainnet API returned HTTP ${response.status}.`, response.status);
      return data as T;
    } catch (error) {
      if (rpc && !(error instanceof ZkPayError)) throw new ZkPayError('RPC_ERROR', 'The configured RPC could not complete the request.');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  async state(): Promise<PoolState> {
    const state = await this.request<PoolState>('/state');
    requireCondition(state.apiVersion === API_VERSION && state.chainId === CHAIN_ID && state.network === 'Robinhood Chain Mainnet', 'WRONG_CHAIN', 'API is not the pinned Robinhood mainnet service.');
    addressEqual(state.pool, this.config.poolAddress, 'pool');
    addressEqual(state.verifier, this.config.verifierAddress, 'verifier');
    addressEqual(state.relayer, this.config.relayerAddress, 'relayer');
    requireCondition(state.deploymentBlock === this.config.deploymentBlock && state.artifactId === this.config.artifactId, 'DEPLOYMENT_MISMATCH', 'Backend deployment block or proof artifacts differ from the pinned release.');
    requireCondition(parseUint(state.baseFeeWei, 'base fee') === BASE_FEE_WEI, 'INVALID_FEE', 'Backend fixed fee differs from the protocol.');
    validateFeeBps(state.feeBps);
    requireCondition(parseUint(state.depositLimitWei, 'deposit limit') <= MAX_AMOUNT, 'INVALID_RESPONSE', 'Deposit limit exceeds the protocol amount range.');
    parseField(state.root, 'root');
    requireCondition(parseField(state.poolDomain, 'pool domain') === poolDomain(this.config.poolAddress), 'DEPLOYMENT_MISMATCH', 'Backend pool domain differs from the pinned deployment.');
    integer(state.nextIndex, 'leaf index', 2 ** TREE_DEPTH);
    integer(state.poolEpoch, 'pool epoch');
    if (state.shutdownAt !== null) integer(state.shutdownAt, 'shutdown time');
    requireCondition(typeof state.closed === 'boolean' && typeof state.initialized === 'boolean' && typeof state.indexing === 'boolean', 'INVALID_RESPONSE', 'Invalid pool status.');
    for (const address of [state.poolAuthority, state.upgradeAuthority, state.bootstrapAuthority]) getAddress(address);
    validateCheckpoint(state.checkpoint);
    return state;
  }
  async events(checkpoint: EventCheckpoint, from = 0, nullifierFrom = 0): Promise<EventPage> {
    const query = new URLSearchParams({ from: String(from), nullifierFrom: String(nullifierFrom), limit: '256', at: String(checkpoint.blockNumber), epoch: checkpoint.epoch });
    const page = await this.request<EventPage>(`/events?${query}`);
    requireCondition(page.apiVersion === API_VERSION && page.chainId === CHAIN_ID, 'WRONG_CHAIN', 'Event page has the wrong network identity.');
    addressEqual(page.pool, this.config.poolAddress, 'pool');
    validateCheckpoint(page.checkpoint);
    requireCondition((Object.keys(checkpoint) as (keyof EventCheckpoint)[]).every((key) => page.checkpoint[key] === checkpoint[key]), 'REORG_RESET', 'Indexer checkpoint changed during pagination.');
    requireCondition(Array.isArray(page.commitments) && Array.isArray(page.nullifiers) && page.commitments.length <= 256 && page.nullifiers.length <= 256, 'INVALID_RESPONSE', 'Event page exceeds the allowed size.');
    page.commitments.forEach((record, offset) => {
      requireCondition(record.index === from + offset && record.index < checkpoint.nextIndex, 'INVALID_EVENTS', 'Missing or reordered commitment event.');
      parseField(record.commitment, 'commitment');
      requireCondition(typeof record.encryptedOutput === 'string' && /^0x(?:[0-9a-f]{2}){0,1024}$/i.test(record.encryptedOutput), 'INVALID_EVENTS', 'Invalid encrypted note envelope.');
    });
    page.nullifiers.forEach((record, offset) => {
      requireCondition(record.index === nullifierFrom + offset && record.index < checkpoint.nextNullifierIndex, 'INVALID_EVENTS', 'Missing or reordered nullifier event.');
      parseField(record.nullifier, 'nullifier');
    });
    for (const record of [...page.commitments, ...page.nullifiers]) {
      integer(record.blockNumber, 'event block'); integer(record.logIndex, 'log index');
      requireCondition(record.blockNumber >= this.config.deploymentBlock && record.blockNumber <= checkpoint.blockNumber && /^0x[0-9a-f]{64}$/i.test(record.blockHash) && /^0x[0-9a-f]{64}$/i.test(record.transactionHash), 'INVALID_EVENTS', 'Event metadata is outside the pinned deployment snapshot.');
    }
    requireCondition(page.nextFrom === from + page.commitments.length && page.nextNullifierFrom === nullifierFrom + page.nullifiers.length, 'INVALID_EVENTS', 'Invalid event cursor.');
    const hasMore = page.nextFrom < checkpoint.nextIndex || page.nextNullifierFrom < checkpoint.nextNullifierIndex;
    requireCondition(page.hasMore === hasMore && (!hasMore || page.commitments.length + page.nullifiers.length > 0), 'INVALID_EVENTS', 'Event pagination stopped before the checkpoint.');
    return page;
  }
  async relay(proof: ContractProof, extData: ExternalData): Promise<RelayResponse> {
    return this.validateRelay(await this.request<RelayResponse>('/relay', { chainId: CHAIN_ID, pool: this.config.poolAddress, proof, extData }));
  }
  async relayStatus(requestId: string): Promise<RelayResponse> {
    requireCondition(/^[a-zA-Z0-9_-]{1,128}$/.test(requestId), 'INVALID_REQUEST_ID', 'Invalid relay request identity.');
    return this.validateRelay(await this.request<RelayResponse>(`/relay/${encodeURIComponent(requestId)}`));
  }
  private validateRelay(value: RelayResponse): RelayResponse {
    requireCondition(!!value && typeof value === 'object' && typeof value.requestId === 'string' && /^0x[0-9a-f]{64}$/.test(value.requestId) && ['pending', 'confirmed', 'failed'].includes(value.status) && (value.transactionHash === null || (typeof value.transactionHash === 'string' && /^0x[0-9a-f]{64}$/i.test(value.transactionHash))) && (value.error === undefined || (typeof value.error === 'string' && /^[A-Z0-9_]{1,80}$/.test(value.error))), 'INVALID_RESPONSE', 'Invalid relay response.');
    requireCondition(value.status !== 'confirmed' || value.transactionHash !== null, 'INVALID_RESPONSE', 'A confirmed relay response must identify a transaction.');
    return value;
  }
  async rpc<T>(method: string, params: unknown[] = []): Promise<T> {
    const id = ++this.rpcId;
    const response = await this.request<{ jsonrpc: string; id: number; result?: T; error?: { message?: string } }>('', { jsonrpc: '2.0', id, method, params }, true);
    requireCondition(!!response && typeof response === 'object' && response.jsonrpc === '2.0' && response.id === id && !response.error && response.result !== undefined, 'RPC_ERROR', 'The mainnet read provider could not complete the request.');
    return response.result;
  }
}
