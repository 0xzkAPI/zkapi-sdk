import test from 'node:test';
import assert from 'node:assert/strict';
import * as mainnet from '../src/index.js';

const rpcUrl = 'https://caller.example/rpc?token=caller-owned';
const profiles = [
  { sdk: mainnet, create: (rpc: string) => mainnet.createRobinhoodMainnetConfig({ origin: 'https://consumer.example', rpcUrl: rpc }), switchChain: mainnet.switchToMainnet },
];

for (const profile of profiles) {
  test(`chain ${profile.sdk.CHAIN_ID}: RPC configuration is explicit, validated, and never defaults`, () => {
    assert.equal(profile.create(rpcUrl).rpcUrl, rpcUrl);
    assert.equal(profile.create('http://127.0.0.1:8545').rpcUrl, 'http://127.0.0.1:8545/');
    for (const value of [undefined, '', '/rpc', 'http://remote.example/rpc', 'ftp://caller.example/rpc', 'https://name:secret@caller.example/rpc', rpcUrl + '#fragment']) {
      assert.throws(() => profile.create(value as string));
    }
    assert.equal('PUBLIC_RPC_URL' in profile.sdk, false);
  });

  test(`chain ${profile.sdk.CHAIN_ID}: wallet registration uses only the caller RPC`, async () => {
    let switched = false;
    let registration: { rpcUrls: string[]; chainId: string } | undefined;
    const provider = { request: async ({ method, params }: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown> => {
      if (method === 'wallet_switchEthereumChain') { if (!switched) { switched = true; throw { code: 4902 }; } return null; }
      if (method === 'wallet_addEthereumChain') { registration = (params as [typeof registration])[0]; return null; }
      if (method === 'eth_chainId') return profile.sdk.CHAIN_ID_HEX;
      throw new Error('Unexpected wallet call');
    } };
    await profile.switchChain(provider, rpcUrl);
    assert.deepEqual(registration?.rpcUrls, [rpcUrl]);
    assert.equal(registration?.chainId, profile.sdk.CHAIN_ID_HEX);
  });

  test(`chain ${profile.sdk.CHAIN_ID}: wallet-free RPC uses caller transport, never the relay API`, async () => {
    const requests: string[] = [];
    const config = profile.create(rpcUrl);
    const fetcher: typeof fetch = async (input, init) => {
      requests.push(String(input));
      assert.equal(init?.credentials, 'omit');
      assert.equal(init?.redirect, 'error');
      const body = JSON.parse(String(init?.body));
      return Response.json({ jsonrpc: '2.0', id: body.id, result: profile.sdk.CHAIN_ID_HEX });
    };
    const api = new profile.sdk.ZkPayApi({ ...config, fetch: fetcher } as never);
    assert.equal(await api.rpc('eth_chainId'), profile.sdk.CHAIN_ID_HEX);
    assert.deepEqual(requests, [rpcUrl]);
  });

  test(`chain ${profile.sdk.CHAIN_ID}: RPC failures never expose URLs or become relay rejection`, async () => {
    for (const fetcher of [
      async () => { throw new Error('Failed to fetch ' + rpcUrl); },
      async () => new Response('<html>' + rpcUrl + '</html>', { status: 503 }),
      async () => Response.json({ error: { code: 'INVALID_INPUT', message: rpcUrl } }, { status: 400 }),
      async () => Response.json(null),
    ]) {
      const api = new profile.sdk.ZkPayApi({ ...profile.create(rpcUrl), fetch: fetcher } as never);
      await assert.rejects(api.rpc('eth_chainId'), (error: unknown) => {
        assert.equal((error as { code: string }).code, 'RPC_ERROR');
        assert.doesNotMatch((error as Error).message, /caller-owned|caller\.example/);
        assert.equal(profile.sdk.isDefiniteRelayRejection(error), false);
        return true;
      });
    }
  });

  test(`chain ${profile.sdk.CHAIN_ID}: a caller RPC on the wrong chain cannot confirm a receipt`, async () => {
    const methods: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      assert.equal(String(input), rpcUrl);
      const body = JSON.parse(String(init?.body));
      methods.push(body.method);
      assert.equal(body.method, 'eth_chainId', 'wrong-chain transport must never read a receipt');
      return Response.json({ jsonrpc: '2.0', id: body.id, result: '0x1' });
    };
    const client = profile.sdk.createZkApiClient({ ...profile.create(rpcUrl), fetch: fetcher } as never);
    const result = await client.waitForConfirmation('0x' + 'ab'.repeat(32), { timeoutMs: 0 });
    assert.equal(result.status, 'pending');
    assert.deepEqual(methods, ['eth_chainId']);
    client.disconnect();
  });
}
