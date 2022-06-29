## git submodules

A lot of canonical code exists outside of this monorepo/metarepo.
A goal of this repo is to create a synthetic trunk of libraries in
the Zcash ecosystem and frequently integrate the different pieces -
getting as close to a full monorepo with real continuous integration
of the entire ecosystem.

There are a variety of ways to try to stay in sync with a bunch of repos.
For now, we use git submodules instead of a eg subtree since the
sub-repos are moving fast and 99.999% of changes will come from the
canonical repos and not from work directly in free2z/free2z.
This document is to help us remember how to keep things in sync!

This assumes git version >= 2.13.

### Cloning

```
git clone --recurse-submodules -j8 https://github.com/free2z/free2z
```

You can also clone and then pull the submodules separately:

```
git clone https://github.com/free2z/free2z
cd free2z
git submodule update --init --recursive
```

### Updating from remotes

The idea is to push the submodule pins as often as possible,
theoretically without breaking anything.

Each submodule in the `.gitmodules` file should refer to a branch
that is the development trunk for the submodule.
With this in place, we can pull and update all of the submodules:

```
git submodule update --recursive --remote
```
