// https://mmazzarolo.com/blog/2021-08-12-building-an-electron-application-using-create-react-app/
// https://www.electronjs.org/docs/v14-x-y/api/context-bridge
// All of the Node.js APIs are available in the preload process.
// It has the same sandbox as a Chrome extension.
const { contextBridge, ipcRenderer } = require("electron");
const warp = require("./warp/index.node")
const DB = require("./warp/DB")
const Account = require("./warp/models/Account");


console.log("PRELOAD")

// warp.initCoin(0, "./zec.db", "https://zuul.free2z.cash:9067")
warp.initCoin(0, "./zec.db", "https://mainnet.lightwalletd.com:9067")

console.log("warp", warp)
// warp.skipToLatestHeight()

const db = new DB("./zec.db")
// console.log("new DB", db)
const account = new Account(db)
// console.log("account model", account)
// console.log("with DB", account.db)
// console.log("account.all!", account.all().then(res => {
//     console.log("THEN", res)
// }))
// const accounts = await account.all()
// console.log("ACCOUNTS", accounts)




// As an example, here we use the exposeInMainWorld API to expose the browsers
// and node versions to the main window.
// They'll be accessible at "window.versions".
process.once("loaded", () => {
    console.log("LOADED")
    contextBridge.exposeInMainWorld("versions", process.versions);
    contextBridge.exposeInMainWorld("ipc", {
        "rewind": (height) => {
            ipcRenderer.send('rewind', height)
        },
        "onIPCSnackbar": (callback) => {
            // (_event, value)
            ipcRenderer.on('ipcsnackbar', callback)
        },
        "open": (link) => {
            ipcRenderer.send('open', link)
        },
        "send": (id, json) => {
            ipcRenderer.send('send', id, json)
        },
    })
    contextBridge.exposeInMainWorld("z", {
        // DB Queries
        "getAllAccounts": () => {
            accounts = account.allWithT()
            return accounts
        },
        "getAccount": (id) => { return account.getAccount(id) },
        "getTransactions": (id) => {
            return account.getTransactions(id)
        },
        "getAccountByName": (name) => { return account.getByName(name) },
        "getTransparentForAccId": (id) => { return account.getTransparent(id) },
        //
        // Height we have syncd to ..
        "getServerHeight": () => {
            return warp.getServerHeight()
        },
        // moves the sync forward to the end
        "skipToLastHeight": () => {
            return warp.skipToLastHeight()
        },
        "getSyncHeight": () => {
            return warp.getSyncHeight()
        },

        // Does this need to be strictly with IPC?
        // Do we need to stop the sync?
        "setActive": (id) => {
            console.log("setACTIVE", id)
            warp.setActiveAccount(0, id)
        },
        // Can just init once here?
        // "initCoin": warp.initCoin,
        // TODO: all of these destructive things should be done
        // via IPC knowing that the current sync is cancelled?
        // Hanh said with authority that only one process should be
        // doing sync/destructive stuff ...
        "newAccount": (name) => { warp.newAccount(0, name) },

        "send": (json) => {
            // TODO: get feedback!! Doh!
            // just block the whole UI? Could work..
            return warp.sendMultiPayment(json)
        }

        // Should never warp from the main world
        // TODO: how to rescan/rewind if only the forkWarp should be
        // moving the sync height and other processes should just read?
        // // from: number
        // "warp": (from) => {
        //     // from is start height / birth height
        //     // coin, offset
        //     warp.warp(0)
        //     // return warp.warp(0, from)
        // }
        // // "Account": account,
    });
});
