# The ZUU

The Zkash User Universe

## Free2Z Open Source

Contribute to Free2Z:

* [ts/react/free2z](./ts/react/free2z/): The Free2Z React Frontend at https://free2z.com/
* [docs/about-free2z](./docs/about-free2z/): Free2Z documentation at https://free2z.com/docs/
* [Free2Z Backend](./py/dj/proj/zuu/README.md): Parts of the Free2Z backend API

Let us know if you would like more modules open sourced!

## Zcash submodules

Check the [.gitmodules](./.gitmodules) file for the complete listing
of external git repos. These are organized by category:

### Core Protocol

* [z/zcash/](https://github.com/zcash) — librustzcash, orchard, sapling-crypto, halo2, pasta_curves, incrementalmerkletree, zcash_note_encryption, zcash_spec, zip32, zips, lightwallet-protocol, zcash-devtool, lightwalletd, zcash (legacy)
* [z/ZcashFoundation/](https://github.com/ZcashFoundation) — zebra, frost, z3

### Wallets & SDKs

* [z/Electric-Coin-Company/](https://github.com/Electric-Coin-Company) — zashi-android, zashi-ios, zcash-android-wallet-sdk, zcash-swift-wallet-sdk
* [z/hhanh00/](https://github.com/hhanh00) — warp, zwallet

### Community

* [z/ChainSafe/](https://github.com/ChainSafe) — WebZjs
* [z/zingolabs/](https://github.com/zingolabs) — zaino, zingolib
* [z/LEONINE-DAO/](https://github.com/LEONINE-DAO) — Nozy-wallet
* [z/QED-it/](https://github.com/QED-it) — librustzcash (ZSA fork)

## Code Layout

Top-level trunk directories:

* `.devcontainer/` - Optional Debian11 container for building most of the code
  in the repo: Rust, Go, npm, Python3, etc
* `z/` - Submodules in `{GITHUB_USER}/{GITHUB_REPO}` format
* `ts/` - TypeScript
* `py/` - Python
* `docs/` - Infinite namespaces for text available
