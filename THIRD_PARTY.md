# SDK provenance and retained notices

The SDK source is licensed GPL-3.0-only, as recorded in `LICENSE` and package
metadata. This standalone distribution derives from the zkPay Robinhood
EVM SDK used by the zkapi application. All upstream licenses remain
unchanged, and no legacy Solana source is relicensed or included.

The original EVM implementation, wallet signing message, key domains, note
format, Merkle reconstruction, HTTP client, transaction orchestration and tests
were independently authored in that EVM project. This release preserves the
Mainnet implementations; the package/export branding does not change protocol
bytes or key derivation. No Solana SDK code is included.

| Component | Version | License and purpose |
| --- | --- | --- |
| ethers | 6.17.0 | MIT; EOA signature verification, ABI encoding, Keccak |
| poseidon-lite | 0.3.0 | MIT; BN254 Poseidon hashes, matching circomlib vectors |
| snarkjs | 0.7.6 | GPL-3.0; lazy browser Groth16 proving and verification |
| TypeScript | 5.9.3 | Apache-2.0; build checking only |
| tsx | 4.23.15 | MIT; test runner only |
| esbuild | 0.28.2 | MIT; browser compatibility build only |
| @types/node | 26.6.3 | MIT; development types |
| @types/snarkjs | 0.7.9 | MIT; development types |
| underscore override | 1.13.8 | MIT; replaces vulnerable snarkjs Node-only transitive 1.13.6 |

Dependency versions and registry integrity hashes are pinned in
`package-lock.json`. `npm run notices` copies installed runtime package manifests
and their original LICENSE/COPYING/NOTICE files to `notices/`, with a complete
runtime manifest. poseidon-lite's package has no separate license file: its
published README explicitly grants MIT for versions >=0.2.0; that README and
package metadata are retained. Its upstream repository is
https://github.com/chancinald/poseidon-lite.

The browser imports snarkjs lazily; code splitting does not remove GPL licensing
obligations. Preserve applicable source, license notices, attribution and build
inputs in any distribution. The package's `private` flag prevents accidental npm
publication and does not substitute for a distribution licensing decision.
No independent audit is claimed. Poseidon uses JavaScript BigInt and does not
claim constant-time execution.

Web Crypto supplies HKDF-SHA-256 and AES-256-GCM; no third-party encryption code
is copied for note recovery. SHA-256 integrity checks cover all fetched proving
artifacts before passing them to snarkjs. Circuit/proving artifacts are not
included in this source package. The pinned artifact identity and development
ceremony limits are described in `docs/sdk-usage.md` and `SECURITY.md`.
