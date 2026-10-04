import test from 'node:test';
import assert from 'node:assert/strict';
import { getBytes } from 'ethers';
import { unlockKeys } from '../src/keys.js';
import { WalletSession } from '../src/wallet.js';
import type { Eip1193Provider } from '../src/wallet.js';
import { HASH, keyDomain, POOL, RECIPIENT, testKeys, wallet } from './fixtures.js';

// Only public, unfunded test vectors and an in-memory provider are used.
// No extension, RPC, browser globals, credentials or submitted transaction.
type Listener = (...args: unknown[]) => void;
const changed = (error: unknown) => (error as { code?: string }).code === 'SESSION_CHANGED';
const identityFailure = (error: unknown) => ['SESSION_CHANGED', 'WRONG_CHAIN'].includes((error as { code?: string }).code ?? '');

async function fixture() {
  const listeners = new Map<string, Set<Listener>>();
  const calls: string[] = [];
  let accounts: unknown = [wallet.address];
  let chain: unknown = '0x1237';
  let invalidations = 0;
  let onSign: (() => void) | undefined;
  let onSubmit: (() => void) | undefined;
  let rejection: { method: string; error: Error } | undefined;
  let deferred: { method: string; ready: () => void; waiting: Promise<void> } | undefined;
  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
  };
  const provider: Eip1193Provider = {
    on: (event, listener) => {
      const group = listeners.get(event) ?? new Set<Listener>();
      group.add(listener); listeners.set(event, group);
    },
    removeListener: (event, listener) => {
      const group = listeners.get(event);
      group?.delete(listener);
      if (group?.size === 0) listeners.delete(event);
    },
    request: async ({ method, params }) => {
      calls.push(method);
      if (rejection?.method === method) {
        const error = rejection.error; rejection = undefined; throw error;
      }
      let result: unknown;
      if (method === 'eth_chainId') result = chain;
      else if (method === 'eth_requestAccounts' || method === 'eth_accounts') result = accounts;
      else if (method === 'eth_getCode') result = '0x';
      else if (method === 'personal_sign') {
        assert(Array.isArray(params));
        assert.equal(params[1], wallet.address);
        result = await wallet.signMessage(getBytes(params[0] as string));
        onSign?.();
      } else if (method === 'eth_sendTransaction') {
        assert(Array.isArray(params));
        assert.equal((params[0] as { from: string }).from, wallet.address);
        onSubmit?.();
        result = HASH;
      } else throw new Error(`Unexpected in-memory provider request: ${method}`);
      // Capture the old response before pausing, as real asynchronous providers can.
      if (deferred?.method === method) {
        const held = deferred; deferred = undefined; held.ready(); await held.waiting;
      }
      return result;
    },
  };
  const session = await WalletSession.connect(provider, { onInvalidate: () => invalidations++ });
  return {
    session, calls, emit,
    invalidations: () => invalidations,
    listenerCount: () => [...listeners.values()].reduce((sum, group) => sum + group.size, 0),
    setAccounts: (value: unknown) => { accounts = value; },
    setChain: (value: unknown) => { chain = value; },
    onSign: (callback: () => void) => { onSign = callback; },
    onSubmit: (callback: () => void) => { onSubmit = callback; },
    rejectNext: (method: string, error: Error) => { rejection = { method, error }; },
    defer: (method: string) => {
      assert.equal(deferred, undefined);
      let ready!: () => void, release!: () => void;
      const reached = new Promise<void>(resolve => { ready = resolve; });
      const waiting = new Promise<void>(resolve => { release = resolve; });
      deferred = { method, ready, waiting };
      return { reached, release };
    },
  };
}

test('same-account and same-chain notifications preserve both verified recovery signatures', async () => {
  const f = await fixture();
  f.onSign(() => {
    const before = f.calls.length;
    f.emit('accountsChanged', [wallet.address.toLowerCase()]);
    f.emit('accountsChanged', [`0x${wallet.address.slice(2).toUpperCase()}`]);
    f.emit('chainChanged', '0x1237');
    f.emit('chainChanged', '0x01237');
    assert.equal(f.calls.length, before, 'redundant events must not trigger provider reads');
  });
  try {
    const keys = await unlockKeys(f.session, keyDomain);
    const baseline = await testKeys();
    assert.equal(keys.spendKey, baseline.spendKey);
    assert.equal(keys.identity, baseline.identity);
    assert.equal(f.calls.filter(method => method === 'personal_sign').length, 2);
    assert.equal(f.invalidations(), 0);
    await f.session.assertActive();
  } finally { f.session.disconnect(); }
  assert.equal(f.listenerCount(), 0);
});

test('an actual A to B to A transition permanently revokes the old session once', async () => {
  const f = await fixture();
  f.emit('accountsChanged', [RECIPIENT]);
  f.emit('accountsChanged', [wallet.address]);
  f.emit('chainChanged', '0x1237');
  f.emit('disconnect');
  assert.equal(f.invalidations(), 1);
  await assert.rejects(f.session.assertActive(), changed);
  await assert.rejects(f.session.signMessage('must not sign'), changed);
  assert.equal(f.calls.includes('personal_sign'), false);
  f.session.disconnect();
  assert.equal(f.listenerCount(), 0);
});

test('account changes during a valid signature discard the result without requesting the second signature', async () => {
  const f = await fixture();
  f.onSign(() => { f.emit('accountsChanged', [RECIPIENT]); f.emit('accountsChanged', [wallet.address]); });
  try {
    await assert.rejects(unlockKeys(f.session, keyDomain), changed);
    assert.equal(f.calls.filter(method => method === 'personal_sign').length, 1);
    assert.equal(f.invalidations(), 1);
  } finally { f.session.disconnect(); }
});

test('revoked, missing and malformed account event payloads fail closed', async () => {
  for (const payload of [[], null, undefined, {}, wallet.address, [null], ['not-an-address']]) {
    const f = await fixture();
    try {
      f.emit('accountsChanged', payload);
      assert.equal(f.invalidations(), 1);
      f.emit('accountsChanged', [wallet.address]);
      await assert.rejects(f.session.assertActive(), changed);
      assert.equal(f.invalidations(), 1);
    } finally { f.session.disconnect(); }
  }
});

test('other-chain, missing and malformed chain event payloads fail closed', async () => {
  for (const payload of ['0x1', '0x0', null, undefined, {}, 4663, '4663', '0x', 'invalid']) {
    const f = await fixture();
    try {
      f.emit('chainChanged', payload);
      assert.equal(f.invalidations(), 1);
      f.emit('chainChanged', '0x1237');
      await assert.rejects(f.session.assertActive(), changed);
      assert.equal(f.invalidations(), 1);
    } finally { f.session.disconnect(); }
  }
});

test('disconnect permanently revokes once even if subsequent events name the original identity', async () => {
  const f = await fixture();
  f.emit('disconnect', { code: 4900, message: 'disconnected' });
  f.emit('disconnect');
  f.emit('accountsChanged', [wallet.address]);
  f.emit('chainChanged', '0x1237');
  assert.equal(f.invalidations(), 1);
  await assert.rejects(f.session.assertActive(), changed);
  f.session.disconnect();
  assert.equal(f.listenerCount(), 0);
});

test('account changes or malformed reads without events permanently invalidate the old session', async () => {
  for (const response of [[RECIPIENT], [], null, undefined, {}, [null], ['not-an-address']]) {
    const f = await fixture();
    try {
      f.setAccounts(response);
      await assert.rejects(f.session.assertActive(), identityFailure);
      assert.equal(f.invalidations(), 1);
      f.setAccounts([wallet.address]);
      await assert.rejects(f.session.assertActive(), changed);
      assert.equal(f.invalidations(), 1);
    } finally { f.session.disconnect(); }
  }
});

test('chain changes or malformed reads without events permanently invalidate the old session', async () => {
  for (const response of ['0x1', null, undefined, {}, 4663, '4663', '0x', 'invalid']) {
    const f = await fixture();
    try {
      f.setChain(response);
      await assert.rejects(f.session.assertActive(), identityFailure);
      assert.equal(f.invalidations(), 1);
      f.setChain('0x1237');
      await assert.rejects(f.session.assertActive(), changed);
      assert.equal(f.invalidations(), 1);
    } finally { f.session.disconnect(); }
  }
});

test('ordinary provider request failures do not masquerade as an identity change', async () => {
  for (const method of ['eth_chainId', 'eth_accounts']) {
    const f = await fixture();
    try {
      const temporary = new Error('Provider temporarily unavailable');
      f.rejectNext(method, temporary);
      await assert.rejects(f.session.assertActive(), error => error === temporary);
      assert.equal(f.invalidations(), 0);
      await f.session.assertActive();
    } finally { f.session.disconnect(); }
  }
});

test('late chain/account responses cannot revive a session revoked during the await', async () => {
  for (const method of ['eth_chainId', 'eth_accounts']) {
    const f = await fixture();
    const held = f.defer(method);
    const active = f.session.assertActive();
    const rejected = assert.rejects(active, changed);
    await held.reached;
    f.emit('accountsChanged', [RECIPIENT]);
    f.emit('accountsChanged', [wallet.address]);
    held.release();
    await rejected;
    assert.equal(f.invalidations(), 1);
    await assert.rejects(f.session.assertActive(), changed);
    f.session.disconnect();
  }
});

test('redundant identity events during awaited reads do not cancel valid work', async () => {
  for (const method of ['eth_chainId', 'eth_accounts']) {
    const f = await fixture();
    const held = f.defer(method);
    const active = f.session.assertActive();
    await held.reached;
    f.emit('accountsChanged', [wallet.address.toLowerCase()]);
    f.emit('chainChanged', '0x1237');
    held.release();
    await active;
    assert.equal(f.invalidations(), 0);
    f.session.disconnect();
  }
});

test('a returned transaction hash is preserved if identity changes during wallet submission', async () => {
  const f = await fixture();
  f.onSubmit(() => f.emit('accountsChanged', [RECIPIENT]));
  try {
    const hash = await f.session.sendTransaction({ to: POOL, data: '0x', value: 1n });
    assert.equal(hash, HASH, 'a broadcast transaction must retain its original recovery identity');
    assert.equal(f.invalidations(), 1);
    await assert.rejects(f.session.assertActive(), changed);
  } finally { f.session.disconnect(); }
});

test('explicit disconnect removes every exact event listener without notifying again', async () => {
  const f = await fixture();
  assert.equal(f.listenerCount(), 3);
  f.session.disconnect();
  f.session.disconnect();
  assert.equal(f.listenerCount(), 0);
  f.emit('accountsChanged', [RECIPIENT]);
  f.emit('disconnect');
  assert.equal(f.invalidations(), 0);
  await assert.rejects(f.session.assertActive(), changed);
});
