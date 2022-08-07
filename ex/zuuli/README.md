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
## zcash-sync
const warp = require("./src/electron/warp/index.node")
warp.initCoin(0, "./zec.db", "https://mainnet.lightwalletd.com:9067")
warp.setActiveAccount(0, 1)

## DB libraries - should be READ-ONLY
const DB = require("./src/electron/warp/DB.js")
const db = new DB("./zec.db")
# TODO: rename this module to `Qs` or something like that.
# I'm sick of this unsemanntic naming ;9
const Account = require("./src/electron/warp/models/Account.js")
const q = new Account(db)
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
npm start
```

See `src/index.tsx` for how the application is setup.


------------


# Getting Started with Create React App

This project was bootstrapped with [Create React App](https://github.com/facebook/create-react-app).

## Available Scripts

In the project directory, you can run:

### `npm start`

Runs the app in the development mode.\
Open [http://localhost:3000](http://localhost:3000) to view it in the browser.

The page will reload if you make edits.\
You will also see any lint errors in the console.

### `npm test`

Launches the test runner in the interactive watch mode.\
See the section about [running tests](https://facebook.github.io/create-react-app/docs/running-tests) for more information.

### `npm run build`

Builds the app for production to the `build` folder.\
It correctly bundles React in production mode and optimizes the build for the best performance.

The build is minified and the filenames include the hashes.\
Your app is ready to be deployed!

See the section about [deployment](https://facebook.github.io/create-react-app/docs/deployment) for more information.

### `npm run eject`

**Note: this is a one-way operation. Once you `eject`, you can’t go back!**

If you aren’t satisfied with the build tool and configuration choices, you can `eject` at any time. This command will remove the single build dependency from your project.

Instead, it will copy all the configuration files and the transitive dependencies (webpack, Babel, ESLint, etc) right into your project so you have full control over them. All of the commands except `eject` will still work, but they will point to the copied scripts so you can tweak them. At this point you’re on your own.

You don’t have to ever use `eject`. The curated feature set is suitable for small and middle deployments, and you shouldn’t feel obligated to use this feature. However we understand that this tool wouldn’t be useful if you couldn’t customize it when you are ready for it.

## Learn More

You can learn more in the [Create React App documentation](https://facebook.github.io/create-react-app/docs/getting-started).

To learn React, check out the [React documentation](https://reactjs.org/).
