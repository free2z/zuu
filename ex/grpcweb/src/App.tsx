import React from 'react';
import logo from './logo.svg';
import './App.css';

import { CompactTxStreamerClient } from "./web/ServiceServiceClientPb"
import { ChainSpec, Duration } from './web/service_pb';
import { Metadata } from 'grpc-web';

// const cli = new CompactTxStreamerClient("https://zuul.free2z.cash:9067")
const cli = new CompactTxStreamerClient("http://localhost:8080")
console.log(cli)
window.cli = cli
// window.name = "foo"

function App() {

  // TODO: 503!!
  const p = cli.getLatestBlock(new Duration(), {} as Metadata)
  p.then((v) => {
    console.log("vvv", v)
  })
  console.log("PPP", p)

  return (
    <div className="App">
      <header className="App-header">
        <img src={logo} className="App-logo" alt="logo" />
        <p>
          Edit <code>src/App.tsx</code> and save to reload.
        </p>
        <a
          className="App-link"
          href="https://reactjs.org"
          target="_blank"
          rel="noopener noreferrer"
        >
          Learn React
        </a>
      </header>
    </div>
  );
}

export default App;
