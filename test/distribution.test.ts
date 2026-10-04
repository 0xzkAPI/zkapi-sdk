import test from 'node:test';
import assert from 'node:assert/strict';
import * as mainnet from '../src/index.js';
import * as compatibility from '../src/mainnet/index.js';
import { keyDomain } from './fixtures.js';

const options = { origin: mainnet.LEGACY_RECOVERY_ORIGIN, rpcUrl: 'https://caller.example/mainnet-rpc' };

test('root import pins the live mainnet deployment and compatibility import shares every export', () => {
  const config = mainnet.createRobinhoodMainnetConfig(options);
  assert.equal(config.chainId, 4663);
  assert.equal(config.apiUrl, 'https://app.zkapi.org/api/hood');
  assert.equal(config.rpcUrl, options.rpcUrl);
  assert.equal(config.poolAddress, '0xF3A2D484d909C48C8581B99750B28D5F9af3E1E6');
  assert.equal(config.verifierAddress, '0x952F13f3c6a41B291f250EF8D0b56986E1F89da0');
  assert.equal(config.relayerAddress, '0x0D7fd3755ca7122db807B21BAc09Bc327a9A7289');
  assert.equal(config.deploymentBlock, 72985549);
  assert.equal(config.confirmations, 33);
  assert.equal(config.artifactId, 'zkpay-robinhood-mainnet-v1-4af878b0d007a820');
  assert.equal(config.artifacts.zkey.url, mainnet.MAINNET_ARTIFACT_BASE_URL + 'transaction2_final.zkey');
  assert.equal(config.artifacts.zkey.sha256, '1760a70b18e0344facc7513e4bef845c722fc35e39c1b6993da5217f65ef3a7f');
  assert.equal(config.artifacts.verificationKey.sha256, 'de305d44edadaddbbdd140a2431c3cf4d07be7a901610481eeef4ad97c0b5943');
  assert.ok(Object.isFrozen(config.artifacts.zkey));
  assert.equal(mainnet.createZkApiClient, mainnet.createZkPayClient);
  assert.equal(mainnet.ZkApiClient, mainnet.ZkPayClient);
  assert.equal(mainnet.createZkApiClient(config).getSnapshot().unlocked, false);
  assert.deepEqual(Object.keys(compatibility), Object.keys(mainnet));
  for (const key of Object.keys(mainnet) as (keyof typeof mainnet)[]) {
    assert.equal(compatibility[key], mainnet[key], `${key} must share its original identity`);
  }
  assert.throws(() => mainnet.createZkApiClient({ ...config, chainId: 1 } as never), /4663/);
});

test('mainnet keeps the original recovery message and shared error identities', () => {
  assert.equal(mainnet.signingMessage(keyDomain), [
    'zkPay private balance recovery — Robinhood Chain Mainnet', '',
    'Sign this message to derive your private balance recovery keys.',
    'This signature does not authorize a transaction or transfer ETH.',
    'Only sign on the trusted zkPay origin shown below.', '',
    'Protocol: zkpay-robinhood-mainnet-v1', `Origin: ${keyDomain.origin}`,
    'Chain ID: 4663', `Pool: ${keyDomain.poolAddress}`, `Account: ${keyDomain.account}`,
    'Key version: 1',
  ].join('\n'));
  const error = new mainnet.TransactionFailedError('TRANSACTION_REVERTED', 'Verified failure');
  assert.equal(mainnet.isDefiniteTransactionFailure(error), true);
  assert.equal(compatibility.isDefiniteTransactionFailure(error), true);
  assert.equal(mainnet.LEGACY_RECOVERY_ORIGIN, 'https://app.zkpay.sh');
});

test('mainnet helper supports explicit service overrides and rejects unsafe service URLs', () => {
  const config = mainnet.createRobinhoodMainnetConfig({ ...options, apiUrl: 'https://consumer.example/api/hood/', artifactBaseUrl: 'https://consumer.example/proof-files' });
  assert.equal(config.apiUrl, 'https://consumer.example/api/hood');
  assert.equal(config.artifacts.wasm.url, 'https://consumer.example/proof-files/transaction2.wasm');
  for (const bad of ['/relative', 'http://consumer.example/api', 'https://user:password@consumer.example/api', 'https://consumer.example/api?key=value', 'https://consumer.example/api#fragment']) {
    assert.throws(() => mainnet.createRobinhoodMainnetConfig({ ...options, apiUrl: bad }));
    assert.throws(() => mainnet.createRobinhoodMainnetConfig({ ...options, artifactBaseUrl: bad }));
  }
  assert.throws(() => mainnet.createRobinhoodMainnetConfig({ ...options, origin: options.origin + '/path' }));
});
