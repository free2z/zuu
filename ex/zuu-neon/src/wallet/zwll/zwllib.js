// Pure node wrapper for aditapk00/zecwallet-light-cli lib
// Just using commonJS for regular node to not go down TS rabbit hole here
// https://stackoverflow.com/a/60615051/177293

/*
> z.litelib_execute("help", "")
'Available commands:\n' +
  'save - Save wallet file to disk\n' +
  'syncstatus - Get the sync status of the wallet\n' +
  'send - Send ZEC to the given address\n' +
  'list - List all transactions in the wallet\n' +
  'decryptmessage - Attempt to decrypt a message with all the view keys in the wallet.\n' +
  'lasttxid - Show the latest TxId in the wallet\n' +
  'height - Get the latest block height that the wallet is at\n' +
  'defaultfee - Returns the default fee in zats for outgoing transactions\n' +
  "info - Get the lightwalletd server's info\n" +
  "zecprice - Get the latest ZEC price in the wallet's currency (USD)\n" +
  'encryptmessage - Encrypt a memo to be sent to a z-address offline\n' +
  'rescan - Rescan the wallet, downloading and scanning all blocks and transactions\n' +
  'help - Lists all available commands\n' +
  'shield - Shield your transparent ZEC into a sapling address\n' +
  'unlock - Unlock wallet encryption for spending\n' +
  'sendprogress - Get the progress of any send transactions that are currently computing\n' +
  'addresses - List all addresses in the wallet\n' +
  'getoption - Get a wallet option\n' +
  'quit - Quit the lightwallet, saving state to disk\n' +
  'clear - Clear the wallet state, rolling back the wallet to an empty state.\n' +
  'decrypt - Completely remove wallet encryption\n' +
  'export - Export private key for wallet addresses\n' +
  'seed - Display the seed phrase\n' +
  'sync - Download CompactBlocks and sync to the server\n' +
  'encrypt - Encrypt the wallet with a password\n' +
  'notes - List all sapling notes and utxos in the wallet\n' +
  'encryptionstatus - Check if the wallet is encrypted and if it is locked\n' +
  'balance - Show the current ZEC balance in the wallet\n' +
  "lock - Lock a wallet that's been temporarily unlocked\n" +
  'new - Create a new address in this wallet\n' +
  'setoption - Set a wallet option\n' +
  'import - Import spending or viewing keys into the wallet'
*/


const z = require('../../../')
const DEFAULT_SERVER = "https://mainnet.lightwalletd.com:9067"
/*
> z = require('.')
{
  litelib_wallet_exists: [Function: zuu_neon::litelib_wallet_exists],
  litelib_initialize_new: [Function: zuu_neon::litelib_initialize_new],
  litelib_initialize_existing: [Function: zuu_neon::litelib_initialize_existing],
  litelib_initialize_new_from_phrase: [Function: zuu_neon::litelib_initialize_new_from_phrase],
  litelib_deinitialize: [Function: zuu_neon::litelib_deinitialize],
  litelib_execute: [Function: zuu_neon::litelib_execute]
}
*/


if (z.litelib_wallet_exists("mainnet")) {
  z.litelib_initialize_existing(DEFAULT_SERVER)
} else {
  z.litelib_initialize_new()
}

module.exports = { z }
console.log("END")
