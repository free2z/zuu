import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import {
  BrowserRouter,
  Routes,
  Route,
  Link,
} from "react-router-dom"
import Send from './Send'
import Transactions from './Transactions'
import Receive from './Receive'
import Intro from './Intro'

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);
root.render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/intro" element={<Intro />} />

        {/* Routes with Account Menu and BottomNav */}
        <Route path="/" element={<App />}>
          <Route path="/receive" element={<Receive />} />
          <Route path="/transactions" element={<Transactions />} />
          <Route path="/send" element={<Send />} />
          <Route path="*"
            element={
              <main style={{ padding: "1rem" }}>
                <p>There's nothing here!</p>
                <Link to="/">Back home!</Link>
              </main>
            }
          />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);