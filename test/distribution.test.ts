import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRobinhoodTestnetConfig, createZkApiClient, createZkPayClient,
  LEGACY_RECOVERY_ORIGIN, ROBINHOOD_TESTNET_DEPLOYMENT, ZkApiClient, ZkPayClient,
  parseEtherExact, formatEtherExact, quoteSend, PROTOCOL, API_VERSION, signingMessage,
} from '../src/index.js';
import { config, keyDomain } from './fixtures.js';

const options = {
  origin: 'https://merchant.example',
  rpcUrl: 'https://caller.example/rpc',
  apiUrl: 'https://merchant.example/api/robinhood/',
  artifactBaseUrl: 'https://merchant.example/zkapi-artifacts',
};

test('zkapi export aliases retain the original constructor and recovery wire identity', () => {
  assert.equal(ZkApiClient, ZkPayClient);
  assert.equal(createZkApiClient, createZkPayClient);
  assert.ok(createZkApiClient(config) instanceof ZkApiClient);
  assert.equal(PROTOCOL, 'zkpay-robinhood-testnet-v1');
  assert.equal(API_VERSION, 'zkpay-robinhood-v1');
  assert.equal(LEGACY_RECOVERY_ORIGIN, 'https://app.zkpay.sh');
  assert.equal(signingMessage(keyDomain), [
    'zkPay private balance recovery — Robinhood Chain Testnet', '',
    'Sign this message to derive your private balance recovery keys.',
    'This signature does not authorize a transaction or transfer ETH.',
    'Only sign on the trusted zkPay origin shown below.', '',
    'Protocol: zkpay-robinhood-testnet-v1', 'Origin: https://test.zkpay.example',
    'Chain ID: 46630', `Pool: ${keyDomain.poolAddress}`, `Account: ${keyDomain.account}`,
    'Key version: 1',
  ].join('\n'));
});

test('deployment helper pins the current deployment while requiring explicit application identity', () => {
  const result = createRobinhoodTestnetConfig(options);
  assert.equal(result.chainId, 46630);
  assert.equal(result.origin, options.origin);
  assert.equal(result.apiUrl, 'https://merchant.example/api/robinhood');
  assert.equal(result.confirmations, 33);
  assert.equal(result.poolAddress, ROBINHOOD_TESTNET_DEPLOYMENT.poolAddress);
  assert.equal(result.artifacts.wasm.url, 'https://merchant.example/zkapi-artifacts/transaction2.wasm');
  assert.equal(result.artifacts.zkey.sha256, ROBINHOOD_TESTNET_DEPLOYMENT.artifactHashes.zkey);
  assert.ok(Object.isFrozen(result.artifacts.wasm));
  assert.equal(createZkApiClient(result).config.origin, options.origin);
});

test('deployment helper rejects remote HTTP, credentials, URL metadata, and non-origin identity', () => {
  for (const bad of ['http://merchant.example/api', 'https://user:password@merchant.example/api', 'https://merchant.example/api?key=value', 'https://merchant.example/api#fragment', '/relative']) {
    assert.throws(() => createRobinhoodTestnetConfig({ ...options, apiUrl: bad }));
    assert.throws(() => createRobinhoodTestnetConfig({ ...options, artifactBaseUrl: bad }));
  }
  assert.throws(() => createRobinhoodTestnetConfig({ ...options, origin: options.origin + '/path' }));
  assert.equal(createRobinhoodTestnetConfig({ ...options, apiUrl: 'http://127.0.0.1:5173/api/robinhood' }).apiUrl, 'http://127.0.0.1:5173/api/robinhood');
});

test('documented offline quote uses exact wei and the stated gross-fee-net amounts', () => {
  const quote = quoteSend(parseEtherExact('0.1'), 20);
  assert.deepEqual([quote.grossWei, quote.feeWei, quote.netWei].map(formatEtherExact), ['0.1', '0.00075', '0.09925']);
});
