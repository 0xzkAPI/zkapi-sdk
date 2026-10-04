import { getAddress, hexlify } from 'ethers';
import { field, requireCondition, ZERO_ADDRESS } from './constants.js';
import type { PrivateKeys } from './keys.js';
import { createNote, encryptNote, randomScalar } from './notes.js';
import type { Note, OwnedNote } from './notes.js';
import { commitment, extDataHash, MAX_AMOUNT, nullifier, poolDomain, publicKey, TREE_DEPTH, validateAmount } from './protocol.js';
import type { MerkleTree } from './tree.js';
import type { ArtifactLocation, ContractProof, ExternalData, Progress, ProofArtifacts } from './types.js';

// Local adapter deliberately avoids ambient snarkjs declarations in host apps.
// The legacy Solana app has a narrower declaration; it remains untouched.
export type CircuitSignals = Record<string, string | string[] | string[][]>;
export interface Groth16Proof { pi_a: string[]; pi_b: string[][]; pi_c: string[]; protocol: string; curve: string }
interface SnarkJsApi {
  groth16: {
    fullProve(input: CircuitSignals, wasm: Uint8Array, zkey: Uint8Array, logger?: unknown, witnessOptions?: { memorySize: number }, proverOptions?: { singleThread: boolean }): Promise<{ proof: Groth16Proof; publicSignals: string[] }>;
    verify(key: unknown, signals: string[], proof: Groth16Proof): Promise<boolean>;
  };
}

export interface PreparedTransaction {
  witness: CircuitSignals;
  publicSignals: string[];
  extData: ExternalData;
  outputNotes: [Note, Note];
  inputNotes: OwnedNote[];
}
export interface ProvedTransaction {
  proof: ContractProof;
  extData: ExternalData;
  publicSignals: string[];
}
export interface LoadedArtifacts { wasm: Uint8Array; zkey: Uint8Array; verificationKey: unknown }

export function selectNotes(notes: readonly OwnedNote[], needed: bigint): OwnedNote[] {
  validateAmount(needed);
  const ordered = [...notes].sort((a, b) => a.amount === b.amount ? a.index - b.index : a.amount > b.amount ? -1 : 1);
  const single = [...ordered].reverse().find((note) => note.amount >= needed);
  if (single) return [single];
  const selected = ordered.slice(0, 2);
  requireCondition(selected.reduce((sum, note) => sum + note.amount, 0n) >= needed, 'INSUFFICIENT_TWO_NOTE_BALANCE', 'This amount requires more than the two notes one transaction can spend. Choose an amount within the available send balance.');
  return selected;
}

/** Build witness entirely in client memory; never serialize this object to a server. */
export async function prepareTransaction(input: {
  keys: PrivateKeys; tree: MerkleTree; inputNotes: OwnedNote[];
  extAmount: bigint; fee: bigint; recipient?: string; feeRecipient?: string;
}): Promise<PreparedTransaction> {
  const { keys, tree } = input;
  requireCondition(input.inputNotes.length <= 2 && input.extAmount !== 0n, 'INVALID_TRANSACTION', 'Transactions require nonzero external value and at most two input notes.');
  validateAmount(input.extAmount > 0n ? input.extAmount : -input.extAmount + input.fee);
  requireCondition(input.fee >= 0n && (input.extAmount < 0n || input.fee === 0n), 'INVALID_FEE', 'Deposits have zero platform fee.');
  const domain = poolDomain(keys.domain.poolAddress);
  const spentIndexes = new Set<number>();
  const inputs = input.inputNotes.map((note) => {
    requireCondition(!spentIndexes.has(note.index), 'DUPLICATE_INPUT', 'The same private note cannot be spent twice.');
    spentIndexes.add(note.index);
    const expected = createNote(keys, note.amount, note.blinding);
    requireCondition(note.pubkey === expected.pubkey && note.commitment === expected.commitment && note.nullifier === nullifier(domain, expected.commitment, keys.spendKey, note.index), 'INVALID_NOTE', 'Input note does not belong to these recovery keys.');
    const path = tree.path(note.index);
    return { amount: note.amount, secret: keys.spendKey, blinding: note.blinding, index: note.index, path: path.elements, nullifier: note.nullifier };
  });
  while (inputs.length < 2) {
    const secret = randomScalar(true), blinding = randomScalar();
    const dummyCommitment = commitment(domain, 0n, publicKey(domain, secret), blinding);
    inputs.push({ amount: 0n, secret, blinding, index: 0, path: Array<bigint>(TREE_DEPTH).fill(0n), nullifier: nullifier(domain, dummyCommitment, secret, 0) });
  }
  requireCondition(inputs[0].nullifier !== inputs[1].nullifier, 'DUPLICATE_INPUT', 'Input nullifiers must be distinct.');
  const outputAmount = inputs.reduce((sum, note) => sum + note.amount, 0n) + input.extAmount - input.fee;
  requireCondition(outputAmount >= 0n && outputAmount <= MAX_AMOUNT * 2n, 'INSUFFICIENT_BALANCE', 'Input balance cannot satisfy this transaction.');
  const firstAmount = outputAmount > MAX_AMOUNT ? MAX_AMOUNT : outputAmount;
  const outputNotes: [Note, Note] = [createNote(keys, firstAmount), createNote(keys, outputAmount - firstAmount)];
  const [encryptedOutput1, encryptedOutput2] = await Promise.all(outputNotes.map((note) => encryptNote(keys, note)));
  const extData: ExternalData = {
    recipient: getAddress(input.recipient ?? ZERO_ADDRESS), extAmount: input.extAmount.toString(),
    feeRecipient: getAddress(input.feeRecipient ?? ZERO_ADDRESS), fee: input.fee.toString(), encryptedOutput1, encryptedOutput2,
  };
  if (input.extAmount < 0n) requireCondition(extData.recipient !== ZERO_ADDRESS && extData.feeRecipient !== ZERO_ADDRESS, 'INVALID_RECIPIENT', 'A send needs nonzero recipient and fee-recipient addresses.');
  const root = tree.root.toString();
  const publicAmount = field(input.extAmount - input.fee).toString();
  const externalHash = extDataHash(keys.domain.poolAddress, extData).toString();
  const inputNullifiers = inputs.map((note) => note.nullifier.toString());
  const outputCommitments = outputNotes.map((note) => note.commitment.toString());
  return {
    extData, outputNotes, inputNotes: [...input.inputNotes],
    publicSignals: [root, publicAmount, externalHash, ...inputNullifiers, ...outputCommitments, domain.toString()],
    witness: {
      root, publicAmount, extDataHash: externalHash, inputNullifiers, outputCommitments, poolDomain: domain.toString(),
      inputAmount: inputs.map((note) => note.amount.toString()), inputSecret: inputs.map((note) => note.secret.toString()),
      inputBlinding: inputs.map((note) => note.blinding.toString()), inputPathIndex: inputs.map((note) => note.index.toString()),
      inputPathElements: inputs.map((note) => note.path.map(String)),
      outputAmount: outputNotes.map((note) => note.amount.toString()), outputPubkey: outputNotes.map((note) => note.pubkey.toString()),
      outputBlinding: outputNotes.map((note) => note.blinding.toString()),
    },
  };
}

async function fetchArtifact(location: ArtifactLocation, fetcher: typeof fetch, maxBytes: number): Promise<Uint8Array> {
  requireCondition(/^[0-9a-f]{64}$/i.test(location.sha256), 'INVALID_ARTIFACT', 'Artifact SHA-256 identity must be pinned before proving.');
  const response = await fetcher(location.url, { credentials: 'omit', cache: 'force-cache' });
  requireCondition(response.ok, 'ARTIFACT_DOWNLOAD', 'Could not load independent mainnet proof artifacts.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  requireCondition(bytes.length > 0 && bytes.length <= maxBytes, 'INVALID_ARTIFACT', 'Artifact size is outside the allowed range.');
  const hash = hexlify(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)))).slice(2);
  requireCondition(hash === location.sha256.toLowerCase(), 'ARTIFACT_INTEGRITY', 'Proof artifact does not match the pinned SHA-256 identity.');
  return bytes;
}
export async function loadArtifacts(artifacts: ProofArtifacts, fetcher: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<LoadedArtifacts> {
  const [wasm, zkey, verificationBytes] = await Promise.all([
    fetchArtifact(artifacts.wasm, fetcher, 32 * 1024 * 1024),
    fetchArtifact(artifacts.zkey, fetcher, 256 * 1024 * 1024),
    fetchArtifact(artifacts.verificationKey, fetcher, 1024 * 1024),
  ]);
  const verificationKey = JSON.parse(new TextDecoder().decode(verificationBytes));
  requireCondition(verificationKey.protocol === 'groth16' && verificationKey.curve === 'bn128' && verificationKey.nPublic === 8, 'INVALID_ARTIFACT', 'Verification key is not for the expected two-input mainnet circuit.');
  return { wasm, zkey, verificationKey };
}

export function contractProof(proof: Groth16Proof, signals: readonly string[]): ContractProof {
  requireCondition(signals.length === 8, 'INVALID_PROOF', 'Expected eight circuit public signals.');
  return {
    pA: [proof.pi_a[0], proof.pi_a[1]],
    pB: [[proof.pi_b[0][1], proof.pi_b[0][0]], [proof.pi_b[1][1], proof.pi_b[1][0]]],
    pC: [proof.pi_c[0], proof.pi_c[1]], root: signals[0], publicAmount: signals[1], extDataHash: signals[2],
    inputNullifiers: [signals[3], signals[4]], outputCommitments: [signals[5], signals[6]], poolDomain: signals[7],
  };
}
export async function proveTransaction(prepared: PreparedTransaction, artifacts: LoadedArtifacts, onProgress?: (progress: Progress) => void): Promise<ProvedTransaction> {
  onProgress?.({ phase: 'proving' });
  const { groth16 } = await import('snarkjs') as unknown as SnarkJsApi;
  const generated = await groth16.fullProve(prepared.witness, artifacts.wasm, artifacts.zkey, undefined, { memorySize: 0 }, { singleThread: true });
  requireCondition(generated.publicSignals.length === 8 && generated.publicSignals.every((value, index) => value === prepared.publicSignals[index]), 'PUBLIC_SIGNAL_MISMATCH', 'Proof public signals differ from the locally prepared transaction.');
  requireCondition(await groth16.verify(artifacts.verificationKey, generated.publicSignals, generated.proof), 'INVALID_PROOF', 'Locally generated proof failed independent verification.');
  return { proof: contractProof(generated.proof, generated.publicSignals), extData: prepared.extData, publicSignals: generated.publicSignals };
}
