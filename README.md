# The ZUU

The 2Z monorepo.

## What is it?

The ZUU is a collection of modules, applications, experiments,
documentation, guides and tools for working within the 2Z UX ecosystem.

The ZUU is a metarepo which creates a synthetic trunk for integrating
different modules within the wider Zero-Knowledge universe.

### Zcash submodules

Check the [.gitmodules](./.gitmodules) file for the complete listing
of external git repos. These currently come from the following orgs and users:

* [z/adityapk00/](https://github.com/adityapk00)
* [z/hhanh00/](https://github.com/hhanh00)
* [z/zcash/](https://github.com/zcash)
* [z/ZcashFoundation/](https://github.com/ZcashFoundation)
* [z/zecwalletco/](https://github.com/zecwalletco)
* [z/zingolabs/](https://github.com/zingolabs)

### Code Layout

Top-level trunk directories:

* `.devcontainer/` - Optional Debian11 container for building most of the code
  in the repo: Rust, Go, npm, Python3, etc
* `docs/` - Documentation, GUIDES and notes
* `ex/` - Experiments and examples
* `private/` - .gitignored for convenience
* `z/` - Submodules in `{GITHUB_USER}/{GITHUB_REPO}` format
