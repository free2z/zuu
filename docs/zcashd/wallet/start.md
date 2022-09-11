Introduced in 4.7.0

https://electriccoin.co/blog/new-release-4-7-0/


```
RpcException: z_getnewaddress: Error: Please acknowledge that you have backed up the wallet's emergency recovery phrase by using zcashd-wallet-tool first. (code -18)
```

Restart the wallet with `-exportdir`

```bash
zcash-cli stop
zcashd -daemon -exportdir=/home/skyl/expt
```

Backup the wallet

```bash
zcash-wallet-tool
```

restart zcashd without `-exportdir`

```
zcash-cli stop
zcashd -daemon
```

Now you can use a client to, for example,
[make a new saping address](https://zcash.github.io/rpc/z_getnewaddress.html)
