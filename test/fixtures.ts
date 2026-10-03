import { Wallet } from 'ethers';
import { CHAIN_ID } from '../src/constants.js';
import { deriveKeys, signingMessage } from '../src/keys.js';
import { poolDomain } from '../src/protocol.js';
import { MerkleTree } from '../src/tree.js';
import type { PoolState, ZkPayConfig } from '../src/types.js';

// Public, unfunded deterministic test vector. Never a deployed account.
export const wallet = new Wallet(`0x${'1'.padStart(64, '0')}`);
export const POOL = '0x1111111111111111111111111111111111111111';
export const VERIFIER = '0x2222222222222222222222222222222222222222';
export const RELAYER = '0x3333333333333333333333333333333333333333';
export const RECIPIENT = '0x4444444444444444444444444444444444444444';
export const HASH = `0x${'ab'.repeat(32)}`;
export const BLOCK_HASH = `0x${'cd'.repeat(32)}`;
export const keyDomain = { origin: 'https://test.zkpay.example', chainId: CHAIN_ID, poolAddress: POOL, account: wallet.address };
export async function testKeys() {
  const signature = await wallet.signMessage(signingMessage(keyDomain));
  return deriveKeys(keyDomain, signature, signature);
}
const artifact = { url: 'https://test.zkpay.example/artifact', sha256: '0'.repeat(64) };
export const config: ZkPayConfig = { chainId: CHAIN_ID, poolAddress: POOL, verifierAddress: VERIFIER, relayerAddress: RELAYER, deploymentBlock: 10, artifactId: 'test-artifacts', origin: keyDomain.origin, artifacts: { wasm: artifact, zkey: artifact, verificationKey: artifact }, confirmationTimeoutMs: 0, confirmationPollMs: 1 };
export function testState(): PoolState {
  const root = new MerkleTree().root.toString();
  return {
    apiVersion: 'zkpay-robinhood-v1', chainId: CHAIN_ID, network: 'Robinhood Chain Testnet', pool: POOL, verifier: VERIFIER, relayer: RELAYER,
    deploymentBlock: 10, artifactId: 'test-artifacts', root, nextIndex: 0, feeBps: 20, baseFeeWei: '550000000000000', depositLimitWei: (10n ** 20n).toString(),
    shutdownAt: null, closed: false, initialized: true, poolAuthority: wallet.address, upgradeAuthority: wallet.address, bootstrapAuthority: wallet.address,
    poolEpoch: 1, poolDomain: poolDomain(POOL).toString(), indexing: false,
    checkpoint: { blockNumber: 20, blockHash: BLOCK_HASH, epoch: '0:1', poolEpoch: 1, root, nextIndex: 0, nextNullifierIndex: 0 },
  };
}
