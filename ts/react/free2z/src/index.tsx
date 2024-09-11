// import * as React from "react"
// import * as ReactDOM from "react-dom"
import { BrowserRouter } from "react-router-dom"
import App from "./App"

import { createRoot } from 'react-dom/client';
import { StrictMode } from "react";

const container = document.getElementById('root');
const root = createRoot(container!);
root.render(
    <StrictMode>
        <BrowserRouter>
            <App />
        </BrowserRouter>
    </StrictMode>
)
