set -e

pushd ../../z/hhanh00/zcash-sync
# nj-cli build --release -- --features=nodejs
nj-cli build -- --features=nodejs
popd
cp ../../z/hhanh00/zcash-sync/dist/index.node ex/zuuli/src/electron/warp/index.node
