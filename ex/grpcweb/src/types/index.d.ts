// Property 'cli' does not exist on type 'Window & typeof globalThis'
export { };

import { CompactTxStreamerClient } from "../web/ServiceServiceClientPb"

declare global {
    interface Window {
        cli: CompactTxStreamerClient;
    }
}
