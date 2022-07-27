## git submodules

A lot of canonical code exists outside of this monorepo/metarepo.
A goal of this repo is to create a synthetic trunk of libraries in
the Zcash ecosystem and frequently integrate the different pieces -
getting as close to a full monorepo with real continuous integration
of the entire ecosystem.

There are a variety of ways to try to stay in sync with a bunch of repos.
For now, we use git submodules instead of a eg subtree since the
sub-repos are moving fast and 99.999% of changes will come from the
canonical repos and not from work directly in free2z/zuu.
This document is to help us remember how to keep things in sync!

This assumes git version >= 2.13.

### Cloning

```
git clone --recurse-submodules -j8 https://github.com/free2z/zuu
```

You can also clone and then pull the submodules separately:

```
git clone https://github.com/free2z/zuu
cd zuu
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

### Adding a submodule

Let's say we want to add
[zingolabs-mobile](https://github.com/zingolabs/zingo-mobile)
to the metarepo. Two things to note:

1. Specify a branch to track with -b
2. Use the user/org name as the top-level directory and the repo name

For 1, specify the development trunk. This will usually be `main`, `master`,
or `dev` depending on the project. Rarely it may be desired to pin to some
other branch. But, the idea is that we track the development versions of
everything and get broken sooner rather than later.

For 2, in this case the directory will be `zingolabs/zingo-mobile`.

```
git submodule add https://github.com/zingolabs/zingo-mobile zingolabs/zingo-mobile -b dev
```
