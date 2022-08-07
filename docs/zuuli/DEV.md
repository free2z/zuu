## Running ZUULI dev version

This document explains how to run the development version of ZUULI:
a minimalist Zcash desktop wallet with warp sync.

This document is a WIP. Please add any notes that others may find
helpful.

### Prereqs

You must install rust and nodejs with npm for your operating system.

### Enter The ZUU

```
git clone --recurse-submodules -j8 https://github.com/free2z/zuu
cd zuu
```

If you've already checked out the repo,
you can pull the submodules from the root directory via:

```
git submodule update --init --recursive
```

Checkout the `dev` branch to live on the wild side

```
git checkout dev
```

### Build hhanh00/zcash-sync into ex/zuuli

Build the free2z node FFI fork of zcash-sync.

```
./build-node-sync.sh
```

### Run the ZUULI electron app

```
cd ex/zuuli
npm install
npm run start
```

> TODO: this will open up a browser window.
> Close the browser window, you don't need it.
> Soon we will have concurrently running properly and won't need
> to run these multiple commands and close browser windows.
> Soon™

In another terminal, also in the `zuu/ex/zuuli` directory,
run the electron app:

```
electronmon .
```

Now, any changes you make in `ex/zuuli/src` will be reloaded.

You can also make changes in `hhanh00/zcash-sync`
and rerun `./build-node-sync.sh`. The changes will be reflected
in the ZUULI interface. Occasionally you may feel the need to
kill electronmon (ctrl+C) and restart it. But, perhaps surprisingly,
it can already run and stay in sync for days on end without restart.
