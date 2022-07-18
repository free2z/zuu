# GRPC-WEB Zcash lightclient experiment

Generated grpc-web client from zcash/lightwalletd/walletrpc.

In the devcontainer, the protoc tool with grpc-web is already installed.

On a Mac, you can install it with:

```
sudo wget https://github.com/grpc/grpc-web/releases/download/1.3.1/protoc-gen-grpc-web-1.3.1-darwin-x86_64
sudo chmod +x protoc-gen-grpc-web-1.3.1-darwin-x86_64
sudo mv protoc-gen-grpc-web-1.3.1-darwin-x86_64 /usr/local/bin/protoc-gen-grpc-web
```

Then you can generate a client in TypeScript with:

```
cd /workspaces/free2z/zcash/lightwalletd/walletrpc
mkdir web

protoc -I=. service.proto compact_formats.proto darkside.proto \
    --js_out=import_style=commonjs:web \
    --grpc-web_out=import_style=typescript,mode=grpcwebtext:web
```

Then copied into the src directory here

```
cp -r web ../../../ex/grpcweb/src
```

For development, install envoy locally for your host machine:

https://www.envoyproxy.io/docs/envoy/latest/start/install

Run the proxy:

```
envoy -c envoy.yaml
```

Now build and deploy the sample app:

```
npm install
npm start
```

WIP

```
Http response at 400 or 500 level
```







------------

The `package.json` and `.env` files here are changed according to
https://github.com/grpc/grpc-web/issues/447

https://medium.com/expedia-group-tech/the-weird-world-of-grpc-tooling-for-node-js-part-2-daafed94cc32

----------------------------------


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
