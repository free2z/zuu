console.log("START WARP!")
const warp = require("./warp/index.node")
// TODO: server as argument?
// warp.initCoin(0, "./zec.db", "https://zuul.free2z.cash:9067")
warp.initCoin(0, "./zec.db", "https://mainnet.lightwalletd.com:9067")
// TODO: skip, rewind and all ...
warp.skipToLastHeight()
warp.warp(0)
console.log("DONE WARP!")
