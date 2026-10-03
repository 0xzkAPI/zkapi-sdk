import test from 'node:test';
import assert from 'node:assert/strict';
import { getBytes, hashMessage, hexlify, SigningKey, Wallet } from 'ethers';
import { CHAIN_ID, FIELD } from '../src/constants.js';
import { formatEtherExact, parseEtherExact, quoteSend } from '../src/fees.js';
import { deriveKeys, normalizeSignature, signingMessage } from '../src/keys.js';
import { createNote, decryptNote, encryptNote, recoverNotes } from '../src/notes.js';
import { extDataHash, hashPair, MAX_AMOUNT, nullifier, poolDomain, publicKey } from '../src/protocol.js';
import { prepareTransaction, selectNotes } from '../src/proof.js';
import { MerkleTree } from '../src/tree.js';
import { assertChain, WalletSession } from '../src/wallet.js';
import { BLOCK_HASH, HASH, keyDomain, POOL, RECIPIENT, RELAYER, testKeys, wallet } from './fixtures.js';

test('integer wei fees: deposit zero, default Send gross, rounding, adjustable bounds', () => {
  assert.deepEqual(quoteSend(parseEtherExact('0.1')), { grossWei: 100000000000000000n, feeWei: 750000000000000n, netWei: 99250000000000000n, feeBps: 20 });
  for (const feeBps of [0, 1, 20, 100]) {
    const amount = 99999999999999999n;
    const quote = quoteSend(amount, feeBps);
    assert.equal(quote.feeWei, amount * BigInt(feeBps) / 10000n + 550000000000000n);
    assert.equal(quote.grossWei, quote.netWei + quote.feeWei);
  }
  assert.throws(() => quoteSend(550000000000000n), /exceed/);
  assert.throws(() => quoteSend(1000000000000000000n, 101));
  assert.throws(() => quoteSend(1000000000000000000n, -1));
  assert.equal(formatEtherExact(parseEtherExact('123456789.000000000000000001')), '123456789.000000000000000001');
  for (const value of ['1e-3', '0.0000000000000000001', '-1', '01', 'NaN', '1,000']) assert.throws(() => parseEtherExact(value));
});

test('deterministic verified EOA keys and chain/pool/account/origin separation', async () => {
  const keys = await testKeys();
  assert.equal((await testKeys()).spendKey, keys.spendKey);
  const changed = { ...keyDomain, poolAddress: RELAYER };
  const signature = await wallet.signMessage(signingMessage(changed));
  const other = await deriveKeys(changed, signature, signature);
  assert.notEqual(keys.spendKey, other.spendKey);
  assert.notEqual(keys.identity, other.identity);
  const otherOrigin = { ...keyDomain, origin: 'https://different.zkpay.example' };
  const otherOriginSignature = await wallet.signMessage(signingMessage(otherOrigin));
  assert.notEqual(keys.spendKey, (await deriveKeys(otherOrigin, otherOriginSignature, otherOriginSignature)).spendKey);
  const otherWallet = new Wallet(`0x${'2'.padStart(64, '0')}`);
  const wrongSignature = await otherWallet.signMessage(signingMessage(keyDomain));
  await assert.rejects(deriveKeys(keyDomain, wrongSignature, wrongSignature), /selected wallet/);
  assert.throws(() => signingMessage({ ...keyDomain, chainId: 4663 as typeof CHAIN_ID }), /limited/);
});

test('high-s ECDSA representation normalizes without changing recovery keys', async () => {
  const signature = await wallet.signMessage(signingMessage(keyDomain));
  const bytes = getBytes(signature);
  const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const highS = order - BigInt(hexlify(bytes.slice(32, 64)));
  const malleated = hexlify(bytes.slice(0, 32)) + highS.toString(16).padStart(64, '0') + (bytes[64] === 27 ? '1c' : '1b');
  assert.equal(normalizeSignature(malleated), normalizeSignature(signature));
  assert.equal((await deriveKeys(keyDomain, signature, malleated)).spendKey, (await testKeys()).spendKey);
});

test('different valid signatures for the same EOA message are rejected before key creation', async () => {
  const message = signingMessage(keyDomain);
  const deterministic = await wallet.signMessage(message);
  const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  // A public mathematical test vector with nonce k=3; never used for real signing.
  const point = SigningKey.computePublicKey(`0x${'3'.padStart(64, '0')}`, true);
  const r = BigInt(`0x${point.slice(4)}`) % order;
  const inverseThree = (2n * order + 1n) / 3n;
  const s = (BigInt(hashMessage(message)) + r) * inverseThree % order;
  const alternate = `0x${r.toString(16).padStart(64, '0')}${s.toString(16).padStart(64, '0')}${point.slice(2, 4) === '03' ? '1c' : '1b'}`;
  await assert.rejects(deriveKeys(keyDomain, deterministic, alternate), /changing signatures/);
});

test('authenticated note encryption restores owned amounts, excludes tampering and other domains', async () => {
  const keys = await testKeys();
  const note = createNote(keys, parseEtherExact('0.1'), 123n);
  const ciphertext = await encryptNote(keys, note);
  assert.deepEqual(await decryptNote(keys, ciphertext, note.commitment), note);
  assert.notEqual(ciphertext, await encryptNote(keys, note));
  const bytes = getBytes(ciphertext); bytes[bytes.length - 1] ^= 1;
  assert.equal(await decryptNote(keys, hexlify(bytes), note.commitment), null);
  assert.equal(await decryptNote(keys, ciphertext, note.commitment + 1n), null);
  const alternate = { ...keyDomain, poolAddress: RELAYER };
  const signature = await wallet.signMessage(signingMessage(alternate));
  assert.equal(await decryptNote(await deriveKeys(alternate, signature, signature), ciphertext, note.commitment), null);
  assert.throws(() => createNote(keys, MAX_AMOUNT + 1n));
});

test('Poseidon known vector, sparse Merkle paths and index boundaries', () => {
  assert.equal(hashPair(1n, 2n), 7853200120776062878684798364095072458815029376092732009249414926327459813530n);
  const tree = new MerkleTree();
  const leaves = [1n, 2n, 3n, 4n, 5n]; leaves.forEach((leaf) => tree.append(leaf));
  leaves.forEach((leaf, index) => assert.equal(MerkleTree.verify(leaf, tree.path(index)), true));
  assert.equal(MerkleTree.verify(9n, tree.path(0)), false);
  assert.throws(() => tree.append(1n, 99));
  assert.throws(() => tree.append(FIELD));
  assert.throws(() => tree.path(5));
});

test('deposit merges notes; partial send and Max conserve gross, fee and encrypted change', async () => {
  const keys = await testKeys(), tree = new MerkleTree();
  const first = await prepareTransaction({ keys, tree, inputNotes: [], extAmount: parseEtherExact('0.1'), fee: 0n });
  assert.equal(first.extData.fee, '0');
  const records = await Promise.all(first.outputNotes.map(async (note, index) => {
    tree.append(note.commitment); return { index, commitment: note.commitment.toString(), encryptedOutput: index === 0 ? first.extData.encryptedOutput1 : first.extData.encryptedOutput2, blockNumber: 20, blockHash: BLOCK_HASH, transactionHash: HASH, logIndex: index };
  }));
  const restored = await recoverNotes(keys, records, new Set());
  assert.equal(restored.length, 1);
  assert.equal(restored[0].amount, parseEtherExact('0.1'));
  const merged = await prepareTransaction({ keys, tree, inputNotes: restored, extAmount: parseEtherExact('0.2'), fee: 0n });
  assert.equal(merged.outputNotes[0].amount, parseEtherExact('0.3'));
  const quote = quoteSend(parseEtherExact('0.03'));
  const sent = await prepareTransaction({ keys, tree, inputNotes: restored, extAmount: -quote.netWei, fee: quote.feeWei, recipient: RECIPIENT, feeRecipient: RELAYER });
  assert.equal(sent.outputNotes[0].amount, parseEtherExact('0.07'));
  assert.equal((await decryptNote(keys, sent.extData.encryptedOutput1, sent.outputNotes[0].commitment))?.amount, parseEtherExact('0.07'));
  const maxQuote = quoteSend(restored[0].amount);
  const max = await prepareTransaction({ keys, tree, inputNotes: restored, extAmount: -maxQuote.netWei, fee: maxQuote.feeWei, recipient: RECIPIENT, feeRecipient: RELAYER });
  assert.equal(max.outputNotes[0].amount, 0n);
  assert.equal((await recoverNotes(keys, records, new Set([restored[0].nullifier.toString()]))).length, 0);
  assert.equal(selectNotes(restored, 100n)[0].commitment, restored[0].commitment);
  await assert.rejects(prepareTransaction({ keys, tree, inputNotes: [restored[0], restored[0]], extAmount: 1n, fee: 0n }), /same private note/);
});

test('external hashes and public keys separate pools and bind recipient and ciphertext', async () => {
  const keys = await testKeys(), tree = new MerkleTree();
  const prepared = await prepareTransaction({ keys, tree, inputNotes: [], extAmount: 100n, fee: 0n });
  const original = extDataHash(POOL, prepared.extData);
  assert.notEqual(original, extDataHash(RELAYER, prepared.extData));
  assert.notEqual(original, extDataHash(POOL, { ...prepared.extData, recipient: RECIPIENT }));
  assert.notEqual(original, extDataHash(POOL, { ...prepared.extData, encryptedOutput1: '0xab' }));
  assert.notEqual(publicKey(poolDomain(POOL), keys.spendKey), publicKey(poolDomain(RELAYER), keys.spendKey));
});

test('wrong chain fails before account/sign requests; smart wallet rejected', async () => {
  const calls: string[] = [];
  const wrong = { request: async ({ method }: { method: string }) => { calls.push(method); return '0x1237'; } };
  await assert.rejects(WalletSession.connect(wrong), /46630/);
  assert.deepEqual(calls, ['eth_chainId']);
  const smart = { request: async ({ method }: { method: string }) => method === 'eth_chainId' ? '0xb626' : method === 'eth_requestAccounts' ? [wallet.address] : '0xabcd' };
  await assert.rejects(WalletSession.connect(smart), /EOA/);
  await assertChain({ request: async () => '0xb626' });
});
