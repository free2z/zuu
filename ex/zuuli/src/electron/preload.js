// All of the Node.js APIs are available in the preload process.
// It has the same sandbox as a Chrome extension.
const { contextBridge } = require("electron");
const warp = require("./warp/index.node")
const DB = require("./warp/DB")
const Account = require("./warp/models/Account")

console.log("PRELOAD")

warp.initCoin(0, "./zec.db", "https://mainnet.lightwalletd.com:9067")

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
    contextBridge.exposeInMainWorld("z", {
        // Can just init once here?
        // "initCoin": warp.initCoin,
        "newAccount": (name) => { warp.newAccount(0, name) },
        "getAccounts": () => { return account.all() },
        "getAccountByName": (name) => { return account.getByName(name) },
        "getTransparentForAccId": (id) => { return account.getTransparent(id) },
        "getAll": () => { return account.allWithT() },
        // "Account": account,
    });
});
