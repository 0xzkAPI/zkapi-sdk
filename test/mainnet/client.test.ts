import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, toUtf8String } from 'ethers';
import { ZkPayApi } from '../../src/mainnet/api.js';
import { createZkPayClient } from '../../src/mainnet/client.js';
import { POOL_ABI, poolDomain, relayRequestId } from '../../src/mainnet/protocol.js';
import type { ContractProof, ExternalData, Progress } from '../../src/mainnet/types.js';
import { BLOCK_HASH, config, HASH, POOL, RECIPIENT, testState, VERIFIER, wallet } from './fixtures.js';

const abi = new Interface(POOL_ABI);
function environment(options: { receipt?: 'success' | 'revert' | 'pending'; failState?: () => boolean; canonical?: boolean; transactionKind?: 'deposit' | 'send'; transactionRecipient?: string; feeBps?: number; checkpoint?: () => number } = {}) {
  const events = new Map<string, (...args: unknown[]) => void>();
  const calls: string[] = [];
  const proof: ContractProof = { pA: ['0', '0'], pB: [['0', '0'], ['0', '0']], pC: ['0', '0'], root: '0', inputNullifiers: ['1', '2'], outputCommitments: ['3', '4'], publicAmount: '1', extDataHash: '0', poolDomain: poolDomain(POOL).toString() };
  const extData: ExternalData = { recipient: options.transactionRecipient ?? POOL, extAmount: options.transactionKind === 'send' ? '-1' : '1', feeRecipient: POOL, fee: '0', encryptedOutput1: '0x', encryptedOutput2: '0x' };
  const provider = {
    on: (event: string, listener: (...args: unknown[]) => void) => { events.set(event, listener); },
    removeListener: (event: string) => { events.delete(event); },
    request: async ({ method, params }: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown> => {
      calls.push(method);
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [wallet.address];
      if (method === 'eth_getCode') return '0x';
      if (method === 'eth_getBalance') return '0xde0b6b3a7640000';
      if (method === 'eth_call') {
        const call = abi.parseTransaction({ data: (params as [{ data: string }])[0].data });
        if (call!.name === 'verifier') return abi.encodeFunctionResult('verifier', [VERIFIER]);
        if (call!.name === 'poolDomain') return abi.encodeFunctionResult('poolDomain', [poolDomain(POOL)]);
        if (call!.name === 'isKnownRoot') return abi.encodeFunctionResult('isKnownRoot', [true]);
      }
      if (method === 'personal_sign') return wallet.signMessage(toUtf8String((params as string[])[0]));
      if (method === 'eth_getTransactionReceipt') return options.receipt === 'pending' ? null : { transactionHash: HASH, blockHash: BLOCK_HASH, blockNumber: '0x14', to: POOL, status: options.receipt === 'revert' ? '0x0' : '0x1' };
      if (method === 'eth_getBlockByNumber') return { hash: options.canonical === false ? HASH : BLOCK_HASH };
      if (method === 'eth_blockNumber') return '0x15';
      if (method === 'eth_getTransactionByHash') return { hash: HASH, to: POOL, blockHash: BLOCK_HASH, blockNumber: '0x14', value: options.transactionKind === 'send' ? '0x0' : '0x1', input: abi.encodeFunctionData('transact', [proof, extData]) };
      throw new Error(`Unexpected method ${method}`);
    },
  };
  const fetcher: typeof fetch = async (input, init) => {
    const path = String(input);
    if (path.endsWith('/rpc')) {
      const rpc = JSON.parse(String(init?.body));
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result: await provider.request(rpc) });
    }
    if (path.endsWith('/state')) {
      if (options.failState?.()) throw new Error('offline');
      const current = testState(); if (options.checkpoint) current.checkpoint.blockNumber = options.checkpoint();
      return Response.json({ ...current, feeBps: options.feeBps ?? 20 });
    }
    if (path.includes('/events?')) {
      const state = testState(); if (options.checkpoint) state.checkpoint.blockNumber = options.checkpoint();
      return Response.json({ apiVersion: state.apiVersion, chainId: state.chainId, pool: state.pool, checkpoint: state.checkpoint, commitments: [], nullifiers: [], nextFrom: 0, nextNullifierFrom: 0, hasMore: false });
    }
    throw new Error(`Unexpected path ${path}`);
  };
  return { provider, fetcher, events, calls, requestId: relayRequestId(POOL, proof, extData) };
}

test('backend mismatch rejects before wallet account or signature requests', async () => {
  const env = environment();
  const state = { ...testState(), chainId: 46630 };
  const client = createZkPayClient({ ...config, fetch: async () => Response.json(state) });
  await assert.rejects(client.connect(env.provider), /pinned Robinhood/);
  assert.equal(env.calls.length, 0);
});

test('connect/unlock/recover and account/network changes invalidate private state', async () => {
  const env = environment(), progress: Progress[] = [];
  let invalidations = 0;
  const client = createZkPayClient({ ...config, fetch: env.fetcher, onProgress: (event) => progress.push(event), onSessionInvalidated: () => invalidations++ });
  assert.equal((await client.connect(env.provider)).walletBalanceWei, 10n ** 18n);
  assert.equal((await client.unlock()).unlocked, true);
  assert.equal(env.calls.filter((method) => method === 'personal_sign').length, 2);
  env.events.get('accountsChanged')!(['0x0000000000000000000000000000000000000001']);
  assert.equal(client.getSnapshot().unlocked, false);
  assert.equal(client.getSnapshot().privateBalanceWei, 0n);
  assert.equal(invalidations, 1);
  await assert.rejects(client.sync(), /Connect an EVM wallet/);
  client.disconnect();
  assert.equal(env.events.size, 0);
});

test('confirmation timeout retains hash and blocks a new transaction', async () => {
  const env = environment({ receipt: 'pending' });
  const client = createZkPayClient({ ...config, fetch: env.fetcher });
  await client.connect(env.provider); await client.unlock();
  assert.deepEqual(await client.waitForConfirmation(HASH), { status: 'pending', transactionHash: HASH, requestId: undefined, quote: undefined });
  await assert.rejects(client.deposit(1n), /existing pending/);
});

test('pending confirmation survives wallet invalidation using the pinned read-only API', async () => {
  const options: { receipt: 'pending' | 'success' } = { receipt: 'pending' };
  const env = environment(options);
  const client = createZkPayClient({ ...config, fetch: env.fetcher });
  await client.connect(env.provider); await client.unlock();
  assert.equal((await client.waitForConfirmation(HASH)).status, 'pending');
  env.events.get('chainChanged')!('0x1');
  assert.equal(client.getSnapshot().account, null);
  options.receipt = 'success';
  assert.equal((await client.waitForConfirmation(HASH)).status, 'confirmed');
});

test('successful canonical receipt stays confirmed when balance refresh is offline', async () => {
  let offline = false;
  const env = environment({ failState: () => offline });
  const client = createZkPayClient({ ...config, fetch: env.fetcher });
  await client.connect(env.provider); await client.unlock();
  offline = true;
  const result = await client.waitForConfirmation(HASH);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.transactionHash, HASH);
  assert.equal(result.blockNumber, 20);
  assert.notEqual(result.balanceRefreshed, true);
});

test('confirmed result reports a successful indexed refresh so the UI need not repeat it', async () => {
  const env = environment();
  const client = createZkPayClient({ ...config, fetch: env.fetcher });
  await client.connect(env.provider); await client.unlock();
  const result = await client.waitForConfirmation(HASH, { requestId: env.requestId });
  assert.equal(result.status, 'confirmed'); assert.equal(result.balanceRefreshed, true);
  assert.equal(client.getSnapshot().state!.checkpoint.blockNumber, result.blockNumber);
});

test('reorged receipt stays pending; reverted receipt never confirms', async () => {
  const reorg = environment({ canonical: false });
  const first = createZkPayClient({ ...config, fetch: reorg.fetcher });
  await first.connect(reorg.provider);
  assert.equal((await first.waitForConfirmation(HASH)).status, 'pending');
  const revert = environment({ receipt: 'revert' });
  const second = createZkPayClient({ ...config, fetch: revert.fetcher });
  await second.connect(revert.provider);
  await assert.rejects(second.waitForConfirmation(HASH), /reverted on chain/);
});

test('an unrelated successful pool transaction cannot confirm a relay request', async () => {
  const env = environment();
  const client = createZkPayClient({ ...config, fetch: env.fetcher });
  await client.connect(env.provider);
  await assert.rejects(client.waitForConfirmation(HASH, { requestId: `0x${'11'.repeat(32)}` }), /does not match this request/);
});

test('confirmed intent and recipient come from bound calldata after pending recovery', async () => {
  for (const kind of ['deposit', 'send'] as const) {
    const env = environment({ transactionKind: kind, transactionRecipient: RECIPIENT });
    const client = createZkPayClient({ ...config, fetch: env.fetcher });
    // Fresh client confirms without trusting any persisted kind/recipient labels.
    const result = await client.waitForConfirmation(HASH, { requestId: env.requestId });
    assert.equal(result.status, 'confirmed');
    assert.equal(result.kind, kind);
    assert.equal(result.recipient, kind === 'send' ? RECIPIENT : '');
  }
});

test('a fee changed since quote review fails before proving or relay submission', async () => {
  const options = { feeBps: 20 };
  const env = environment(options), phases: string[] = [];
  const client = createZkPayClient({ ...config, fetch: env.fetcher, onProgress: (progress) => phases.push(progress.phase) });
  await client.connect(env.provider); await client.unlock();
  options.feeBps = 30;
  await assert.rejects(client.send({ grossWei: 100000000000000000n, recipient: RECIPIENT, expectedFeeBps: 20 }), (error: unknown) => (error as { code?: string }).code === 'FEE_CHANGED');
  assert.equal(client.getSnapshot().state?.feeBps, 30);
  assert.equal(phases.includes('proving'), false);
  assert.equal(phases.includes('relaying'), false);
});

test('pinned deployment, fee, artifact identity and event pagination reject tampering', async () => {
  for (const modification of [{ pool: VERIFIER }, { baseFeeWei: '1' }, { artifactId: 'other' }, { feeBps: 101 }, { poolDomain: '0' }]) {
    const api = new ZkPayApi({ ...config, fetch: async () => Response.json({ ...testState(), ...modification }) });
    await assert.rejects(api.state());
  }
  const state = testState();
  const api = new ZkPayApi({ ...config, fetch: async () => Response.json({ apiVersion: state.apiVersion, chainId: state.chainId, pool: state.pool, checkpoint: state.checkpoint, commitments: [], nullifiers: [], nextFrom: 1, nextNullifierFrom: 0, hasMore: false }) });
  await assert.rejects(api.events(state.checkpoint), /cursor/);
});

test('closed pool exposes zero spendable balance without treating root0 as an empty Merkle root', async () => {
  const env = environment();
  const closed = { ...testState(), closed: true, initialized: false, root: '0', checkpoint: { ...testState().checkpoint, root: '0' } };
  const client = createZkPayClient({ ...config, fetch: async () => Response.json(closed) });
  await client.connect(env.provider);
  const snapshot = await client.unlock();
  assert.equal(snapshot.privateBalanceWei, 0n);
  assert.equal(snapshot.maxSpendableWei, 0n);
});


test('confirmed receipt keeps cached older balance stale until its checkpoint catches up', async () => {
  let checkpoint = 20;
  const env = environment({ checkpoint: () => checkpoint });
  const client = createZkPayClient({ ...config, fetch: env.fetcher });
  await client.connect(env.provider); await client.unlock();
  checkpoint = 19;
  const confirmed = await client.waitForConfirmation(HASH);
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.blockNumber, 20);
  const catchingUp = (error: unknown) => (error as { code?: string }).code === 'INDEXER_CATCHING_UP';
  await assert.rejects(client.sync(), catchingUp);
  const signedBefore = env.calls.filter(x => x === 'personal_sign').length;
  await assert.rejects(client.unlock(), catchingUp);
  assert.equal(env.calls.filter(x => x === 'personal_sign').length, signedBefore);
  await assert.rejects(client.deposit(1n), catchingUp);
  checkpoint = 20;
  assert.equal((await client.sync()).state!.checkpoint.blockNumber, 20);
  client.disconnect();
});
