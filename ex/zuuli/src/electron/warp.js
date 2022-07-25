const warp = require("./warp/index.node")
warp.initCoin(0, "./zec.db", "https://zuul.free2z.cash:9067")
warp.warp(0)
console.log("DONE WARP!")
