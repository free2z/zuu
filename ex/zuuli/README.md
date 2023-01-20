# ZUULI

Zuuli is the Zcash lightwallet that you always wanted.


## Local dev

This application depends on the excellent work of zcash-sync by hanh,
which can be found at `hhanh00/zcash-sync` in the zuu repo.

In the root of the zuu repository, run:

```
./build-node-sync.sh
```

Now in the `ex/zuuli` directory, install

```
npm i
```

Run the electron app in dev:

```
# TODO: concurrently not working meh .. `npm run electron:start`
npm run start
electronmon .
```

## Node CLI

It can be helpful to use the node CLI to examine the behavior of
zcash-sync and interrogate the database.

From the root of the repository, run `node`.
Within node, you can import the zcash-sync FFI and
run some database queries against the SQLite db, `zec.db`.

```nodejs
# Helper that is resilient to network errors for syncing
const forkWarp = require("./src/electron/fork.js").forkWarp
# launches in fork process and restarts on error
forkWarp()
#
# zcash-sync node FFI
const warp = require("./src/electron/warp/index.node")
warp.initCoin(0, "./zec.db", "https://mainnet.lightwalletd.com:9067")
warp.setActiveAccount(0, 1)

## DB libraries - should be READ-ONLY
const DB = require("./src/electron/warp/DB.js")
const db = new DB("./zec.db")
# TODO: rename this module to `Qs` or something like that?
# it's not really a model, it's a collection of query methods ...
const Account = require("./src/electron/warp/models/Account.js")
const acc = new Account(db)
const Transaction = require("./src/electron/warp/models/Transaction.js")
const tx = new Transaction(db)
```



-------

# Dev notes

Install node and npm.
This is tested against the current LTS which is about `16.15.1`

```
npm config set legacy-peer-deps true
```

```
npm install
npm run electron:start
```

See `src/index.tsx` for how the application is setup.
