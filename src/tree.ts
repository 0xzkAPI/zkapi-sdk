import { parseField, requireCondition } from './constants.js';
import { hashPair, TREE_DEPTH, validateScalar } from './protocol.js';
import type { CommitmentRecord } from './types.js';

export interface MerklePath { index: number; elements: bigint[]; root: bigint }

/** Public-only sparse tree. Never calls the service for a private note's path. */
export class MerkleTree {
  readonly zeros: readonly bigint[];
  private readonly levels: Map<number, bigint>[];
  private count = 0;
  constructor() {
    const zeros = [0n];
    for (let i = 0; i < TREE_DEPTH; i++) zeros.push(hashPair(zeros[i], zeros[i]));
    this.zeros = Object.freeze(zeros);
    this.levels = Array.from({ length: TREE_DEPTH + 1 }, () => new Map());
  }
  get size(): number { return this.count; }
  get root(): bigint { return this.levels[TREE_DEPTH].get(0) ?? this.zeros[TREE_DEPTH]; }
  /** Stage a suffix without rehashing historical leaves or mutating the verified tree. */
  clone(): MerkleTree {
    const tree = new MerkleTree();
    tree.count = this.count;
    this.levels.forEach((level, index) => { tree.levels[index] = new Map(level); });
    return tree;
  }
  append(value: bigint, expectedIndex = this.count): void {
    validateScalar(value);
    requireCondition(expectedIndex === this.count && this.count < 2 ** TREE_DEPTH, 'INVALID_EVENTS', 'Commitment indexes are not contiguous or the tree is full.');
    let index = this.count++;
    this.levels[0].set(index, value);
    for (let level = 0; level < TREE_DEPTH; level++) {
      const sibling = this.levels[level].get(index ^ 1) ?? this.zeros[level];
      value = index & 1 ? hashPair(sibling, value) : hashPair(value, sibling);
      index = Math.floor(index / 2);
      this.levels[level + 1].set(index, value);
    }
  }
  path(index: number): MerklePath {
    requireCondition(Number.isSafeInteger(index) && index >= 0 && index < this.count, 'INVALID_NOTE_INDEX', 'Note is not in the synchronized tree.');
    const originalIndex = index;
    const elements: bigint[] = [];
    for (let level = 0; level < TREE_DEPTH; level++) {
      elements.push(this.levels[level].get(index ^ 1) ?? this.zeros[level]);
      index = Math.floor(index / 2);
    }
    return { index: originalIndex, elements, root: this.root };
  }
  static verify(leaf: bigint, path: MerklePath): boolean {
    if (path.elements.length !== TREE_DEPTH || path.index < 0 || path.index >= 2 ** TREE_DEPTH) return false;
    let index = path.index;
    let value = leaf;
    for (const sibling of path.elements) {
      value = index & 1 ? hashPair(sibling, value) : hashPair(value, sibling);
      index = Math.floor(index / 2);
    }
    return value === path.root;
  }
}

export function rebuildMerkleTree(records: readonly CommitmentRecord[], expectedRoot?: string): MerkleTree {
  const tree = new MerkleTree();
  for (const record of records) tree.append(parseField(record.commitment, 'commitment'), record.index);
  if (expectedRoot !== undefined) requireCondition(tree.root === parseField(expectedRoot, 'root'), 'ROOT_MISMATCH', 'Public event history does not match the pool Merkle root.');
  return tree;
}
