# The ZUU

The Zcash UI Universe.

## What is it?

The ZUU is a collection of modules, applications, experiments,
documentation, guides and tools for working within the Zcash
UX ecosystem.

The ZUU is a metarepo which creates a synthetic trunk for integrating
different modules within the wider Zcash universe.

## What does it have?

The ZUU is a monorepo to the extent possible.
If canonical versions of code and documentation can live here, great.
However, many important modules in the Zcash universe
have their own canonical source control, not
the least of which, for example, [zcash/zcash](https://github.com/zcash/zcash).
Having these external modules here enables a sort of "synthetic trunk"
for cross-project integrations and references.

The focus is primarily on UI/UX.
However, everything is included so that collaboration can happen
across the entire lightwallet stack all the way to the full nodes and
the infrastructure, not to mention documentation and code generation, etc.

### submodules

Check the [.gitmodules](./.gitmodules) file for the complete listing
of external git repos. These currently come from the following orgs and users:

* [adityapk00/](https://github.com/adityapk00)
* [hhanh00/](https://github.com/hhanh00)
* [zcash/](https://github.com/zcash)
* [ZcashFoundation/](https://github.com/ZcashFoundation)
* [zecwalletco/](https://github.com/zecwalletco)
* [zingolabs/](https://github.com/zingolabs)

### Code Layout

The submodule directories are all in the format `./{GITHUB_USER}/{GITHUB_REPO}`.
So, for example, the repo at https://github.com/zcash/lightwalletd is
in The ZUU at the directory `./zcash/lightwalletd`.

Top-level trunk directories:

* `.devcontainer/` - Debian11 container for building all of the code
  in the repo: Rust, Go, npm, Python3, etc
* `docs/` - Documentation, GUIDES and notes
* `ex/` - Non-production experiments and examples
* `private/` - .gitignored for convenience
* `zuul/` - Code for the ZUUL family of light wallets (TODO)

> Note the code to free2z.cash is not yet open sourced.
> Perhaps it will go into a new top-level directory `apps/` or `web/`
> with friends like zecpages.com
