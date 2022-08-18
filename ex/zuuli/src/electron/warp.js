console.log("START WARP!")
const warp = require("./warp/index.node")
// TODO: server as argument?
// warp.initCoin(0, "./zec.db", "https://zuul.free2z.cash:9067")
warp.initCoin(0, "./zec.db", "https://mainnet.lightwalletd.com:9067")
// TODO: skip, rewind and all ...
// If no accounts, skip to Last .. else just pick up ...
// if error ... rewind? ...
// warp.skipToLastHeight()
// try {
warp.warp()
// too much of a problem that the exception can't be caught
// maybe it's OK and we can just run again on error?

// thread '<unnamed>' panicked at 'called `Result::unwrap()` on an `Err` value: status: Unknown, message: "error reading a body from connection: stream error received: unspecific protocol error detected", details: [], metadata: MetadataMap { headers: {} }
// Caused by:
// 0: error reading a body from connection: stream error received: unspecific protocol error detected
// 1: stream error received: unspecific protocol error detected', hhanh00/zcash-sync/src/nodejs.rs:199:10
// note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace
// fatal runtime error: failed to initiate panic, error 5

// } catch (e) {
//     const syncH = warp.getSyncHeight()
//     console.log("FML", e)
//     warp.rewindToHeight(syncH - 100)
// }
console.log("DONE WARP!")
