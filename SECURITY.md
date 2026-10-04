# Security model

Version 0.3 supports native ETH on Robinhood Chain Mainnet (`4663`) only. Import it from `@zkapi/robinhood-sdk`; the `/mainnet` compatibility alias exposes the same implementation and constructors. Transaction methods can move real funds. Neither the SDK nor its deployment is claimed to be independently audited. Matching the pinned proof artifacts does not establish a publicly verified multiparty setup.

The parent application has exercised real Mainnet Deposit, recovery, Send, and Max. The standalone repository's current checks are offline; they do not constitute a fresh live payment acceptance test. This source distribution includes SDK code and examples, not frontend, Worker, contract, or operator deployment source. It does not support USDG or other tokens.

## Recovery signatures

`unlock()` requests the same `personal_sign` message twice. Both signatures must recover the selected EOA and be identical after low-s normalization. HKDF-SHA-256 derives separate spend and AES-256-GCM encryption keys. Smart contract/delegated wallets and changing signatures are rejected.

The recovery signature can recreate spending and note-decryption keys. It must be treated as secret recovery material, even though it is not a transaction signature. Do not send it to a server, log it, capture it in telemetry, or put it in local/session storage. The same restrictions apply to plaintext notes, keys, and proof witnesses.

The signed message includes a protocol/version, origin, chain, pool, and wallet account. The official app retains `https://app.zkpay.sh`, the `zkpay-robinhood-mainnet-v1` protocol, and its exact legacy signing text. Changing any derivation input changes the private identity. The configurable origin is a key-separation input, not browser attestation; malicious software can request the same message. Inspect and trust the application requesting recovery signatures.

JavaScript memory is not a secure enclave. The SDK clears references on disconnect or wallet changes, but cannot guarantee erasure against a compromised browser, extension, operating system, or garbage collector. Poseidon uses JavaScript BigInt and is not claimed to run in constant time.

## What is private, and what remains public

Groth16 proofs hide note ownership and the consumed note values while proving the circuit's conditions. Notes are encrypted with authenticated encryption. The client fetches public event pages and reconstructs the Merkle tree locally; it does not request a path for a particular owned commitment.

Deposits, originating wallet addresses, withdrawal recipients, amounts crossing the pool boundary, fees, transaction times, ciphertext, commitments, and nullifiers remain public on chain. The relay, RPC service, hosting provider, and network observers may see IP addresses, request timing, and other metadata. Reusing addresses, unique amounts, short delays, or a small pool can make transactions linkable. A fresh recipient address alone does not guarantee anonymity.

## Trust boundaries

- **Application and wallet:** application code sees signatures and secret state in memory. A compromised frontend can steal them. Wallet RPC responses are also trusted inputs, checked where possible against pinned deployment identity.
- **Indexer:** ordered public commitments are checked against the reported checkpoint root. The SDK does not independently authenticate every indexed log against a separate consensus source. A malicious backend can provide a false view or omit encrypted note data. Local root checks and authenticated decryption do not prove indexer completeness or availability.
- **Read providers:** connected chain reads use the selected wallet provider. Receipt recovery without an active wallet session uses the caller's HTTP `rpcUrl`. Receipt checks verify block identity, confirmations, contract, calldata, ETH value, and request fingerprint against that provider. A malicious provider can misrepresent chain state. These are consistency checks, not a light client; configuring another URL does not make the SDK a provider-quorum verifier.
- **Relay:** the relay receives proof and public external data, pays transaction gas, and can delay or censor withdrawals. Binding the recipient and fee in the proof prevents undetected redirection under the protocol assumptions. Service availability is not guaranteed.
- **Contracts and administrators:** the deployed pool is upgradeable and has administrative controls, including fee and pool lifecycle controls. Addresses are pinned, but the SDK does not make administrators powerless or attest immutable implementation bytecode. Review the current deployment before use.
- **Circuit and setup:** proof soundness depends on the circuit, implementation, verifier, cryptographic assumptions, and trusted setup. Matching artifact hashes verifies file identity, not independent correctness or a trustworthy ceremony.

## Caller-selected RPC and services

The configuration helper and direct `ZkApiConfig` objects require `rpcUrl`. There is no bundled RPC, discovery from API responses, automatic provider failover, or fallback to `${apiUrl}/rpc`. The indexer/relay selected by `apiUrl` remains a separate dependency. Mainnet's helper has API and artifact-host defaults; those are not RPC defaults or promises of access/availability.

When a wallet needs a network added, `wallet_addEthereumChain` receives the caller-supplied URL. An already configured wallet may continue using its own network transport. Select trustworthy providers for both contexts; the caller URL does not control every connected wallet request.

RPC URLs permit HTTPS or explicit HTTP loopback development, reject embedded usernames/passwords and fragments, and may include provider tokens in paths or query strings. Do not log the URL, whole client configuration, request objects, or provider errors that may contain credentials. Browser configuration and network-registration requests expose the URL to the browser and wallet, so do not put a server-only credential there. Third-party browser access requires suitable CORS or a controlled proxy for each of API, HTTP RPC, and artifacts. A proxy must never receive recovery signatures, private notes, or proof witnesses.

Use the pinned Mainnet configuration and proving artifacts. Alternate hosting must preserve the expected bytes. Do not disable hash verification to accommodate an incorrect asset deployment.

## Pending transactions

Keep the public transaction hash and request ID as soon as `onProgress` exposes them. Do not save keys, notes, witnesses, or signatures. Public pending metadata can still reveal an association between a browser and a transaction, so retain only what is needed.

Timeouts, 429/5xx responses, reorgs, and transport failures do not establish that a payment failed. Only verified `confirmed` results are success. `isDefiniteTransactionFailure(error)` recognizes validated terminal failures; generic exceptions are not permission to create a replacement payment.

On reload, recover by the original `requestId` and transaction hash. `retryRelay` can resend an exact proof only while that proof is still in this client's memory. If the relay never stored the request and the page was reloaded, the ID alone cannot reconstruct the proof. Keep an unknown result unresolved until it is reconciled.

A confirmed receipt and a current spendable balance are different results. If public indexing has not reached the receipt block, keep the confirmed public reconciliation record and disable spending until synchronization catches up. Preserve that record across reloads; SDK in-memory checkpoint guards do not supply durable application storage.

## Reporting

Report reproducible non-sensitive issues in the repository. Do not publish private keys, recovery signatures, wallet files, or live exploit details in an issue. This repository does not yet designate a private security-reporting address; coordinate with the maintainer before sharing sensitive material.
