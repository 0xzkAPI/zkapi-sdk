import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, toUtf8String } from 'ethers';
import { createZkPayClient } from '../../src/mainnet/client.js';
import { confirmationDelay } from '../../src/mainnet/polling.js';
import { createNote, encryptNote } from '../../src/mainnet/notes.js';
import { nullifier, POOL_ABI, poolDomain } from '../../src/mainnet/protocol.js';
import { MerkleTree } from '../../src/mainnet/tree.js';
import { WalletSession } from '../../src/mainnet/wallet.js';
import type { CommitmentRecord, EventPage, NullifierRecord } from '../../src/mainnet/types.js';
import { BLOCK_HASH, config, HASH, POOL, RECIPIENT, testKeys, testState, VERIFIER, wallet } from './fixtures.js';

const abi = new Interface(POOL_ABI);
async function fixture() {
  const keys = await testKeys(), requests: string[] = [], calls: string[] = [];
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const state = testState(), records: CommitmentRecord[] = [], nullifiers: NullifierRecord[] = [];
  const tree = new MerkleTree();
  let canonical = true;
  let onReceipt: (() => void) | undefined;
  let deferred: { method: string; remaining: number; reached: () => void; waiting: Promise<void> } | undefined;
  let transformPage: (page: EventPage) => EventPage = page => page;
  const provider = {
    on: (event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener); },
    removeListener: (event: string, listener: (...args: unknown[]) => void) => { if (listeners.get(event) === listener) listeners.delete(event); },
    request: async ({ method, params }: { method: string; params?: unknown[] | Record<string, unknown> }) => {
      calls.push(method);
      const hold = deferred;
      if (hold?.method === method && --hold.remaining === 0) { deferred = undefined; hold.reached(); await hold.waiting; }
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [wallet.address];
      if (method === 'eth_getCode') return '0x';
      if (method === 'eth_getBalance') return '0xde0b6b3a7640000';
      if (method === 'personal_sign') return wallet.signMessage(toUtf8String((params as string[])[0]));
      if (method === 'eth_getBlockByNumber') return { hash: canonical ? state.checkpoint.blockHash : HASH };
      if (method === 'eth_getTransactionReceipt') { onReceipt?.(); return null; }
      if (method === 'eth_call') {
        const name = abi.parseTransaction({ data: (params as [{ data: string }])[0].data })!.name;
        if (name === 'verifier') return abi.encodeFunctionResult(name, [VERIFIER]);
        if (name === 'poolDomain') return abi.encodeFunctionResult(name, [poolDomain(POOL)]);
        if (name === 'isKnownRoot') return abi.encodeFunctionResult(name, [true]);
      }
      throw new Error('Unexpected fixture method: ' + method);
    },
  };
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input), config.origin); requests.push(url.pathname + url.search);
    if (url.pathname.endsWith('/state')) return Response.json(state);
    if (url.pathname.endsWith('/events')) {
      const from = Number(url.searchParams.get('from')), nf = Number(url.searchParams.get('nullifierFrom'));
      const commitments = records.slice(from, from + 256), spent = nullifiers.slice(nf, nf + 256);
      return Response.json(transformPage({ apiVersion: state.apiVersion, chainId: state.chainId, pool: state.pool, checkpoint: state.checkpoint,
        commitments, nullifiers: spent, nextFrom: from + commitments.length, nextNullifierFrom: nf + spent.length,
        hasMore: from + commitments.length < records.length || nf + spent.length < nullifiers.length }));
    }
    throw new Error('Unexpected fixture path');
  };
  const advance = (block: number) => {
    state.checkpoint = { ...state.checkpoint, blockNumber: block, blockHash: `0x${block.toString(16).padStart(64, '0')}`, root: tree.root.toString(), nextIndex: records.length, nextNullifierIndex: nullifiers.length };
    state.root = state.checkpoint.root; state.nextIndex = records.length;
  };
  const append = async (amount: bigint, spentValues: bigint[], block: number) => {
    advance(block);
    const metadata = { blockNumber: block, blockHash: state.checkpoint.blockHash, transactionHash: HASH, logIndex: 0 };
    for (const value of [amount, 0n]) {
      const note = createNote(keys, value);
      records.push({ ...metadata, index: records.length, commitment: note.commitment.toString(), encryptedOutput: await encryptNote(keys, note) });
      tree.append(note.commitment);
    }
    spentValues.forEach(value => nullifiers.push({ ...metadata, index: nullifiers.length, nullifier: value.toString() }));
    advance(block);
  };
  const client = createZkPayClient({ ...config, fetch: fetcher });
  return { client, provider, listeners, state, records, nullifiers, tree, calls, requests, keys, advance, append,
    newClient: () => createZkPayClient({ ...config, fetch: fetcher }),
    setCanonical(value: boolean) { canonical = value; }, alterPage(transform: (page: EventPage) => EventPage) { transformPage = transform; },
    onReceipt(callback: () => void) { onReceipt = callback; },
    deferResponse(method: string, occurrence = 1) {
      let reached!: () => void, release!: () => void;
      const ready = new Promise<void>(resolve => { reached = resolve; });
      const waiting = new Promise<void>(resolve => { release = resolve; });
      deferred = { method, remaining: occurrence, reached, waiting };
      return { ready, release };
    },
    eventRequests: () => requests.filter(url => url.includes('/events?')) };
}

test('incremental public cursors avoid historical refetch on empty blocks and decrypt only suffix notes', async () => {
  const f = await fixture();
  await f.client.connect(f.provider); await f.client.unlock();
  assert.equal(f.eventRequests().length, 0, 'empty cold snapshot needs no event page');
  await f.append(7n, [11n, 12n], 21);
  assert.equal((await f.client.sync()).privateBalanceWei, 7n);
  assert.match(f.eventRequests().at(-1)!, /from=0&nullifierFrom=0/);
  const oldNullifier = nullifier(poolDomain(POOL), BigInt(f.records[0].commitment), f.keys.spendKey, 0);
  const before = f.eventRequests().length, rpcBefore = f.calls.length;
  f.advance(22); f.state.feeBps = 30;
  assert.equal((await f.client.sync()).privateBalanceWei, 7n);
  assert.equal(f.eventRequests().length, before, 'new empty canonical block reuses verified public tree');
  assert.deepEqual(f.calls.slice(rpcBefore), ['eth_chainId', 'eth_accounts', 'eth_getBalance', 'eth_getBlockByNumber', 'eth_chainId', 'eth_accounts']);
  assert.equal(f.client.getSnapshot().state!.feeBps, 30, 'current fees are never cached');
  await f.append(9n, [oldNullifier, 13n], 23);
  assert.equal((await f.client.sync()).privateBalanceWei, 9n, 'old note spent; only new note is spendable');
  assert.match(f.eventRequests().at(-1)!, /from=2&nullifierFrom=2/);
  assert.equal(f.client.getSnapshot().noteCount, 1);
  const copy = f.tree.clone(); copy.append(1n);
  assert.equal(f.tree.size, 4, 'suffix staging cannot mutate a verified tree');
  assert.equal(copy.size, 5);
  f.client.disconnect();
});

test('reorg revision, noncanonical checkpoints and account reconnect invalidate incremental caches', async () => {
  const f = await fixture();
  await f.client.connect(f.provider); await f.client.unlock();
  await f.append(7n, [11n, 12n], 21); await f.client.sync();
  f.state.checkpoint.epoch = '1:1'; f.advance(22);
  assert.equal((await f.client.sync()).privateBalanceWei, 7n);
  assert.match(f.eventRequests().at(-1)!, /from=0&nullifierFrom=0/, 'reorg revision starts public replay from zero');
  f.setCanonical(false); f.advance(23);
  await assert.rejects(f.client.sync(), (error: unknown) => (error as { code?: string }).code === 'CHECKPOINT_REORG');
  assert.equal(f.client.getSnapshot().privateBalanceWei, 0n);
  f.setCanonical(true);
  assert.equal((await f.client.sync()).privateBalanceWei, 7n);
  assert.match(f.eventRequests().at(-1)!, /from=0&nullifierFrom=0/);
  f.listeners.get('accountsChanged')!([]);
  assert.equal(f.client.getSnapshot().privateBalanceWei, 0n);
  await f.client.connect(f.provider); assert.equal((await f.client.unlock()).privateBalanceWei, 7n);
  assert.match(f.eventRequests().at(-1)!, /from=0&nullifierFrom=0/, 'reconnected identity never inherits private cache');
  f.client.disconnect();
});

test('concurrent refreshes share one in-flight verified snapshot but no stale-state TTL', async () => {
  const f = await fixture();
  await f.client.connect(f.provider); await f.client.unlock();
  await f.append(7n, [11n, 12n], 21);
  const before = f.requests.length;
  const values = await Promise.all([f.client.sync(), f.client.sync(), f.client.sync()]);
  assert(values.every(snapshot => snapshot.privateBalanceWei === 7n));
  assert.equal(f.requests.slice(before).filter(path => path.endsWith('/state')).length, 1);
  assert.equal(f.eventRequests().length, 1);
  f.state.feeBps = 35; await f.client.sync();
  assert.equal(f.client.getSnapshot().state!.feeBps, 35, 'later refresh never reuses cached state');
  f.client.disconnect();
});

test('duplicate spent events and forged suffix roots cannot adopt an invalid incremental balance', async () => {
  const f = await fixture();
  await f.client.connect(f.provider); await f.client.unlock();
  await f.append(7n, [11n, 12n], 21); await f.client.sync();
  await f.append(9n, [13n, 14n], 22); f.state.checkpoint.root = '1';
  await assert.rejects(f.client.sync(), (error: unknown) => (error as { code?: string }).code === 'ROOT_MISMATCH');
  assert.equal(f.client.getSnapshot().privateBalanceWei, 7n, 'invalid staged suffix preserves the last good snapshot');
  f.advance(22); await f.client.sync();
  f.nullifiers.push({ ...f.nullifiers[0], index: f.nullifiers.length }); f.advance(23);
  await assert.rejects(f.client.sync(), /Duplicate/);
  assert.equal(f.client.getSnapshot().privateBalanceWei, 16n, 'duplicate marker cannot corrupt the last good snapshot');
  f.client.disconnect();
});

test('missing, duplicate and out-of-order delta leaves fail closed without mutating the verified prefix', async () => {
  for (const corrupt of [
    (page: EventPage) => ({ ...page, commitments: page.commitments.slice(1) }),
    (page: EventPage) => ({ ...page, commitments: [page.commitments[0], page.commitments[0]] }),
    (page: EventPage) => ({ ...page, commitments: [...page.commitments].reverse() }),
    (page: EventPage) => ({ ...page, nullifiers: page.nullifiers.slice(1) }),
  ]) {
    const f = await fixture();
    await f.client.connect(f.provider); await f.client.unlock();
    await f.append(7n, [11n, 12n], 21); await f.client.sync();
    await f.append(9n, [13n, 14n], 22); f.alterPage(corrupt);
    await assert.rejects(f.client.sync(), (error: unknown) => (error as { code?: string }).code === 'INVALID_EVENTS');
    assert.equal(f.client.getSnapshot().privateBalanceWei, 7n);
    f.alterPage(page => page);
    assert.equal((await f.client.sync()).privateBalanceWei, 16n);
    assert.match(f.eventRequests().at(-1)!, /from=2&nullifierFrom=2/, 'failed staging never advances the public cursor');
    f.client.disconnect();
  }
});

test('backwards public counters replay from zero and a cold client reads public SQL pages, never wallet logs', async () => {
  const f = await fixture();
  await f.client.connect(f.provider); await f.client.unlock();
  await f.append(7n, [11n, 12n], 21); await f.client.sync();
  await f.append(9n, [13n, 14n], 22); await f.client.sync();
  f.records.splice(2); f.nullifiers.splice(2);
  const earlier = new MerkleTree(); f.records.forEach(record => earlier.append(BigInt(record.commitment)));
  f.advance(23); f.state.root = f.state.checkpoint.root = earlier.root.toString();
  assert.equal((await f.client.sync()).privateBalanceWei, 7n);
  assert.match(f.eventRequests().at(-1)!, /from=0&nullifierFrom=0/);
  f.client.disconnect();
  const coldClient = f.newClient();
  await coldClient.connect(f.provider); await coldClient.unlock();
  assert.match(f.eventRequests().at(-1)!, /from=0&nullifierFrom=0/);
  assert(!f.calls.includes('eth_getLogs'), 'historical replay is served by public event HTTP, not wallet RPC scanning');
  assert(f.eventRequests().every(path => !/commitment=|nullifier=|owner=|account=/.test(path)), 'requests contain only public sequential cursors');
  coldClient.disconnect();
});

test('new contract epoch discards old leaves and private notes while replaying persistent public nullifiers', async () => {
  const f = await fixture();
  await f.client.connect(f.provider); await f.client.unlock();
  await f.append(7n, [11n, 12n], 21); await f.client.sync();
  f.records.splice(0); f.advance(22);
  f.state.poolEpoch = f.state.checkpoint.poolEpoch = 2;
  f.state.checkpoint.epoch = '0:2';
  f.state.root = f.state.checkpoint.root = new MerkleTree().root.toString();
  assert.equal((await f.client.sync()).privateBalanceWei, 0n);
  assert.match(f.eventRequests().at(-1)!, /from=0&nullifierFrom=0/);
  assert.equal(f.state.checkpoint.nextNullifierIndex, 2);
  f.client.disconnect();
});

test('explicit indexer catch-up retains last verified notes but blocks recovery signatures and proving', async () => {
  const f = await fixture();
  await f.client.connect(f.provider); await f.client.unlock();
  await f.append(7n, [11n, 12n], 21); await f.client.sync();
  const beforeEvents = f.eventRequests().length, beforeCalls = f.calls.length;
  f.state.indexing = true;
  const catchesUp = (error: unknown) => (error as { code?: string }).code === 'INDEXER_CATCHING_UP';
  await assert.rejects(f.client.sync(), catchesUp);
  assert.equal(f.client.getSnapshot().privateBalanceWei, 7n, 'partial history cannot replace last verified notes with zero');
  assert.equal(f.client.getSnapshot().state!.indexing, true);
  await assert.rejects(f.client.deposit(1n), catchesUp);
  await assert.rejects(f.client.unlock(), catchesUp);
  assert.equal(f.eventRequests().length, beforeEvents);
  assert(!f.calls.slice(beforeCalls).includes('personal_sign'));
  assert(!f.calls.slice(beforeCalls).includes('eth_sendTransaction'));
  f.state.indexing = false;
  assert.equal((await f.client.sync()).privateBalanceWei, 7n);
  f.client.disconnect();
});

test('confirmation backoff bounds a 120-second unmined wait to at most 15 checks instead of 49', () => {
  assert.deepEqual([0, 1, 2, 3].map(attempt => confirmationDelay(undefined, attempt)), [2500, 5000, 10000, 10000]);
  let time = 0, checks = 1;
  for (let retry = 0; time < 120000; retry++) { time = Math.min(120000, time + confirmationDelay(undefined, retry)); checks++; }
  assert.equal(checks, 15);
  assert.equal(confirmationDelay(30000, 20), 30000, 'explicit slower polling is not sped up');
});

test('Send Max computes its amount inside one fresh guarded sync, not a preliminary duplicate sync', async () => {
  const f = await fixture();
  await f.client.connect(f.provider); await f.client.unlock();
  const before = f.requests.length;
  await assert.rejects(f.client.sendMax(RECIPIENT), /positive|amount/i);
  assert.equal(f.requests.slice(before).filter(path => path.endsWith('/state')).length, 1);
  f.client.disconnect();
});

test('hidden or offline confirmation makes zero requests and retains the original pending identity', async () => {
  for (const [property, value] of [['document', { visibilityState: 'hidden' }], ['navigator', { onLine: false }]] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, property);
    Object.defineProperty(globalThis, property, { configurable: true, value });
    try {
      let calls = 0;
      const client = createZkPayClient({ ...config, fetch: async () => { calls++; throw new Error('must not fetch'); } });
      const result = await client.waitForConfirmation(HASH, { requestId: BLOCK_HASH, timeoutMs: 10000 });
      assert.equal(result.status, 'pending'); assert.equal(result.requestId, BLOCK_HASH); assert.equal(result.transactionHash, HASH); assert.equal(calls, 0);
    } finally { if (previous) Object.defineProperty(globalThis, property, previous); else Reflect.deleteProperty(globalThis, property); }
  }
});

test('disconnect during confirmation stops further rounds and preserves the original public identity', async () => {
  const f = await fixture();
  await f.client.connect(f.provider); await f.client.unlock();
  f.onReceipt(() => f.client.disconnect());
  const before = f.calls.length;
  const result = await f.client.waitForConfirmation(HASH, { requestId: BLOCK_HASH, timeoutMs: 10000 });
  assert.equal(result.status, 'pending'); assert.equal(result.requestId, BLOCK_HASH); assert.equal(result.transactionHash, HASH);
  assert.deepEqual(f.calls.slice(before), ['eth_chainId', 'eth_accounts', 'eth_getTransactionReceipt']);
  assert.equal(f.client.getSnapshot().account, null);
});

test('a deferred final account response cannot restore private caches after account/chain/disconnect invalidation', async () => {
  for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) {
    const f = await fixture();
    await f.client.connect(f.provider); await f.client.unlock();
    await f.append(7n, [11n, 12n], 21); await f.client.sync();
    await f.append(9n, [13n, 14n], 22);
    const held = f.deferResponse('eth_accounts', 2); // Final assertActive, after suffix restoration.
    const syncing = f.client.sync();
    const rejected = assert.rejects(syncing, (error: unknown) => (error as { code?: string }).code === 'SESSION_CHANGED');
    await held.ready;
    f.listeners.get(event)!();
    assert.equal(f.client.getSnapshot().privateBalanceWei, 0n);
    held.release(); // Provider returns the OLD captured account despite its event.
    await rejected;
    const snapshot = f.client.getSnapshot();
    assert.equal(snapshot.account, null); assert.equal(snapshot.unlocked, false);
    assert.equal(snapshot.privateBalanceWei, 0n); assert.equal(snapshot.noteCount, 0); assert.equal(snapshot.walletBalanceWei, 0n);
    await f.client.connect(f.provider); assert.equal((await f.client.unlock()).privateBalanceWei, 16n);
    assert.match(f.eventRequests().at(-1)!, /from=0&nullifierFrom=0/, 'reconnect performs fresh recovery, not resurrected prefix reuse');
    f.client.disconnect();
  }
});

test('WalletSession independently rejects invalidation during an awaited account response', async () => {
  const f = await fixture();
  const session = await WalletSession.connect(f.provider);
  const held = f.deferResponse('eth_accounts');
  const rejected = assert.rejects(session.assertActive(), (error: unknown) => (error as { code?: string }).code === 'SESSION_CHANGED');
  await held.ready; f.listeners.get('accountsChanged')!(); held.release();
  await rejected; session.disconnect();
});

test('a deferred wallet balance response cannot repopulate cleared balance after disconnect', async () => {
  const f = await fixture();
  await f.client.connect(f.provider); await f.client.unlock();
  const held = f.deferResponse('eth_getBalance');
  const rejected = assert.rejects(f.client.sync(), (error: unknown) => (error as { code?: string }).code === 'SESSION_CHANGED');
  await held.ready; f.listeners.get('disconnect')!(); held.release();
  await rejected;
  assert.equal(f.client.getSnapshot().walletBalanceWei, 0n); assert.equal(f.client.getSnapshot().account, null);
});

test('an old deferred sync failure cannot erase a reconnected session’s newly restored notes', async () => {
  const f = await fixture();
  await f.client.connect(f.provider); await f.client.unlock();
  await f.append(7n, [11n, 12n], 21); await f.client.sync();
  await f.append(9n, [13n, 14n], 22);
  const held = f.deferResponse('eth_getBlockByNumber');
  const rejected = assert.rejects(f.client.sync(), (error: unknown) => (error as { code?: string }).code === 'SESSION_CHANGED');
  await held.ready; f.listeners.get('accountsChanged')!();
  await f.client.connect(f.provider); assert.equal((await f.client.unlock()).privateBalanceWei, 16n);
  f.setCanonical(false); held.release(); await rejected;
  assert.equal(f.client.getSnapshot().privateBalanceWei, 16n);
  assert.equal(f.client.getSnapshot().unlocked, true);
  assert.equal(f.client.getSnapshot().account, wallet.address);
  f.client.disconnect();
});
