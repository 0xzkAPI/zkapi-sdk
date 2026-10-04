import test from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, keccak256, toUtf8Bytes } from 'ethers';
import { API_VERSION, ZkPayApi } from '../../src/mainnet/api.js';
import { CHAIN_ID, CHAIN_ID_HEX, PROTOCOL, EXPLORER_URL, FIELD } from '../../src/mainnet/constants.js';
import { signingMessage, deriveKeys } from '../../src/mainnet/keys.js';
import { PROTOCOL_DOMAIN, EXT_DATA_DOMAIN, poolDomain } from '../../src/mainnet/protocol.js';
import { config, keyDomain, POOL, testState, wallet } from './fixtures.js';

test('mainnet identities, domains and recovery message are explicit and stable', async () => {
  assert.equal(CHAIN_ID, 4663); assert.equal(CHAIN_ID_HEX, '0x1237');
  assert.equal(PROTOCOL, 'zkpay-robinhood-mainnet-v1'); assert.equal(API_VERSION, PROTOCOL);
  assert.equal(EXPLORER_URL, 'https://robinhoodchain.blockscout.com');
  assert.equal(PROTOCOL_DOMAIN, keccak256(toUtf8Bytes('zkPay/Robinhood/Mainnet/v1/pool')));
  assert.equal(EXT_DATA_DOMAIN, keccak256(toUtf8Bytes('zkPay/Robinhood/Mainnet/v1/ext-data')));
  const domain = { ...keyDomain, origin: 'https://app.zkpay.sh' };
  const expected = ['zkPay private balance recovery — Robinhood Chain Mainnet', '',
    'Sign this message to derive your private balance recovery keys.',
    'This signature does not authorize a transaction or transfer ETH.',
    'Only sign on the trusted zkPay origin shown below.', '',
    'Protocol: zkpay-robinhood-mainnet-v1', 'Origin: https://app.zkpay.sh',
    'Chain ID: 4663', `Pool: ${POOL}`, `Account: ${wallet.address}`, 'Key version: 1'].join('\n');
  assert.equal(signingMessage(domain), expected);
  const sig = await wallet.signMessage(expected);
  assert.equal((await deriveKeys(domain, sig, sig)).domain.origin, 'https://app.zkpay.sh');
  const legacyMessage = expected.replaceAll('Mainnet', 'Testnet').replace('zkpay-robinhood-mainnet-v1', 'zkpay-robinhood-testnet-v1').replace('Chain ID: 4663', 'Chain ID: 46630');
  const legacySig = await wallet.signMessage(legacyMessage);
  await assert.rejects(deriveKeys(domain, legacySig, legacySig), /selected wallet/);
  const abi = AbiCoder.defaultAbiCoder();
  const legacyDomain = BigInt(keccak256(abi.encode(['bytes32', 'uint256', 'address'], [keccak256(toUtf8Bytes('zkPay/Robinhood/Testnet/v1/pool')), 46630n, POOL]))) % FIELD;
  assert.notEqual(poolDomain(POOL), legacyDomain);
  assert.throws(() => poolDomain(POOL, 46630 as typeof CHAIN_ID), /Unsupported/);
});

test('old API protocol/network cannot masquerade as a mainnet deployment', async () => {
  for (const changed of [{ apiVersion: 'zkpay-robinhood-v1' }, { network: 'Robinhood Chain Testnet' }, { chainId: 46630 }]) {
    const api = new ZkPayApi({ ...config, fetch: async () => Response.json({ ...testState(), ...changed }) });
    await assert.rejects(api.state(), /pinned Robinhood/);
  }
});
