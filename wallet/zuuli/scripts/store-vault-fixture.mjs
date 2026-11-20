import assert from "node:assert/strict";

// Closed public synthetic read snapshot. No key material, payable address,
// transactions, authenticated account, pending send, or completed sync.
const EXPECTED = {
  "schemaVersion": 1,
  "profile": "vault-empty-v1",
  "locale": "en-US",
  "identityClassification": "public-synthetic-empty-wallet",
  "status": {
    "initialized": true,
    "hasSeed": true,
    "syncedHeight": null,
    "chainTip": null,
    "activeWalletId": "00000000-0000-4000-8000-000000000000",
    "activeWalletName": "Personal wallet",
    "walletCount": 1,
    "backupRequired": false,
    "cleanup": {
      "pendingOperations": 0,
      "blockedOperations": 0,
      "pendingStages": 0,
      "completedStages": 0,
      "diagnostics": []
    },
    "legacyAppData": {
      "state": "none",
      "legacyIdentifier": null,
      "diagnostic": null
    }
  },
  "wallets": [
    {
      "id": "00000000-0000-4000-8000-000000000000",
      "name": "Personal wallet",
      "isActive": true,
      "birthdayHeight": null,
      "createdAt": "2026-08-19T12:00:00.000Z"
    }
  ],
  "balance": {
    "accountIndex": 0,
    "totalShielded": 0,
    "spendable": 0,
    "changePending": 0,
    "valuePending": 0
  },
  "unifiedAddress": "PUBLIC-SYNTHETIC-NONPAYABLE",
  "sync": {
    "syncing": false,
    "syncedHeight": 0,
    "chainTip": 0,
    "progressPercent": 0,
    "lastError": null
  },
  "transactions": [],
  "pendingSend": null
};
export function validateVaultFixture(value) {
  assert.deepEqual(value, EXPECTED, "vault capture must use only the reviewed public empty snapshot");
}

// Injected by Playwright before the unchanged production renderer starts.
// This module is never imported by src/ or by Vite. There is no native host.
export function installVaultNativeFixture({ fixture, action }) {
  const calls = [], refused = [];
  Object.defineProperty(window, "__STORE_VAULT_AUDIT__", { value: { calls, refused } });
  const noArgs = (args) => JSON.stringify(args ?? {}) === "{}";
  const accountZero = (args) => JSON.stringify(args) === '{"args":{"accountIndex":0}}';
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {
    async invoke(command, args) {
      calls.push(command);
      if (command === "free2z_session_sync" && JSON.stringify(args) === '{"args":{"token":null}}') return null;
      if (noArgs(args)) {
        if (command === "oauth_callback_transport") return "desktop";
        if (command === "plugin:zcash|get_wallet_status") return structuredClone(fixture.status);
        if (command === "plugin:zcash|list_wallets") return structuredClone(fixture.wallets);
        if (command === "plugin:zcash|get_sync_status") return structuredClone(fixture.sync);
        if (command === "plugin:zcash|get_pending_send" && action === "wallet-send") return null;
        // bootstrap attempts this automatically. Refuse it without invoking a
        // sync engine or presenting a successful connection. The store catches it.
        if (command === "plugin:zcash|start_sync") throw new Error("Sync is unavailable");
      }
      if (accountZero(args)) {
        if (command === "plugin:zcash|get_account_balance") return structuredClone(fixture.balance);
        // Bootstrap requires a string even on routes which never display it.
        // A deliberately nonpayable sentinel is never shown or QR-encoded.
        if (command === "plugin:zcash|get_unified_address") return fixture.unifiedAddress;
        if (command === "plugin:zcash|get_transaction_history" && action === "wallet-history") return [];
      }
      refused.push(command);
      throw new Error("Native operation refused by capture");
    },
  } });
}
