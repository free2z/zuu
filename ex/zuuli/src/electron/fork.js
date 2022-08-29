const path = require("path")
const { fork } = require('child_process')

const warp = require("./warp/index.node")

// Maybe have to do this in every process to call other methods such
// as getServerHeight ....
// at least all these initCoin calls (2 too many?) seem to resolve
// relative to the process that is running (eg electronmon .)
// Maybe have to revisit when packaging?
// warp.initCoin(0, "./zec.db", "https://mainnet.lightwalletd.com:9067")
warp.initCoin(0, "./zec.db", "https://zuul.free2z.cash:9067")


const xprts = {}
xprts.warp = warp

let p


function forkWarp(from) {
    console.log(new Date())
    if (from !== undefined) {
        // TODO
        // console.log("REWIND to", from)
        // just kidding, rewinding can lose witnesses so .. yeah
        // maybe implement this later but haphazard rewind isn't a good
        // idea ...
        // warp.rewindToHeight(from)
    }
    // console.log("forkWarp")
    p = fork(path.join(__dirname, 'warp.js'), [], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    });
    // console.log("set on close")
    p.on('error', (err) => {
        console.log('ERROR', err)
        // console.log(arguments)
        // try again in 30 seconds
        setTimeout(forkWarp, 1000)
    })
    p.on('close', (code, signal) => {
        console.log("CLOSE AND RESTART", code, signal)
        const syncH = warp.getSyncHeight()
        console.log("SYNC", warp.getSyncHeight())
        console.log("Server", warp.getServerHeight())
        // TODO: differentiate between errors?
        // TODO: how much is the right amount to rewind?
        // only need to rewind for chain reorg?
        // probably bury chain reorg rewind in the FFI code?
        if (code !== 0) {
            console.log("ERROR")
            // warp.rewindToHeight(syncH - 10)
            setTimeout(forkWarp, 1000)
            return
        }
        console.log("start again in 30 seconds")
        setTimeout(forkWarp, 30000)
    });
}

xprts.forkWarp = forkWarp

module.exports = xprts
