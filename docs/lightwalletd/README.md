## Setting up zcashd and lighwalletd

This guide is intended to help you setup Zcashd and lightwalletd.
Assuming a VM with 2 CPU, 8GB of RAM and 100GB of storage and Debian 11
(bullseye).
It also assumes that you are acting as a non-root user who has sudo.

### zcashd

Following the officially supported Debian/Ubuntu setup guide.
https://zcash.readthedocs.io/en/latest/rtd_pages/Debian-Ubuntu-build.html
Using the prebuilt packages:
https://zcash.readthedocs.io/en/latest/rtd_pages/install_debian_bin_packages.html

```
sudo apt-get update && sudo apt-get install apt-transport-https wget gnupg2
```

```
wget -qO - https://apt.z.cash/zcash.asc | gpg --import
gpg --export 3FE63B67F85EA808DE9B880E6DEF3BAF272766C0 | sudo apt-key add -
```


```
echo "deb [arch=amd64] https://apt.z.cash/ bullseye main" | sudo tee /etc/apt/sources.list.d/zcash.list
```

```
sudo apt-get update && sudo apt-get install zcash
```

Fetch the params.

```
zcash-fetch-params
```

Create a default config file:

```
mkdir ~/.zcash
touch ~/.zcash/zcash.conf
```

Edit the config file to have `rpcuser`, `rpcpassword` and `server=1`,
something like:

```
rpcuser=somethingsomething
rpcpassword=SOMESECRETPASSWORDFORREAL
server=1
txindex=1
insightexplorer=1
experimentalfeatures=1
```

According to the current lightwalletd docs, you need these options.
https://github.com/zcash/lightwalletd#zcashd

https://zcash.readthedocs.io/en/latest/rtd_pages/zcash_conf_guide.html

Finally, start zcashd with `-daemon`

```
zcashd -daemon
```

<!-- OR, use `zcash-cli`: -->


See that it's running:

```
ps ax | grep zcash
```

```
zcash-cli getinfo
```

Returns something like:

```
{
  "version": 5000050,
  "build": "v5.0.0",
  "subversion": "/MagicBean:5.0.0/",
  "protocolversion": 170100,
  "walletversion": 60000,
  "balance": 0.00000000,
  "blocks": 90535,
  "timeoffset": 0,
  "connections": 8,
  "proxy": "",
  "difficulty": 944128.6190201412,
  "testnet": false,
  "keypoololdest": 1656459172,
  "keypoolsize": 101,
  "paytxfee": 0.00000000,
  "relayfee": 0.00000100,
  "errors": "",
  "errorstimestamp": 1656460288
}
```

> TODO: run with systemd? run with cookie-file auth?

https://github.com/zcash/zcash/issues/1732
https://github.com/zcash/zcash/pull/1999
https://github.com/bitcoin/bitcoin/pull/6388
https://bitcoin.stackexchange.com/questions/46782/rpc-cookie-authentication

### lightwalletd

Install Go.

Taken from https://www.itzgeek.com/how-tos/linux/debian/how-to-install-go-lang-on-debian-11-debian-10.html

```
sudo apt update
sudo apt install wget -y
wget https://golang.org/dl/go1.17.linux-amd64.tar.gz
sudo tar -zxvf go1.17.linux-amd64.tar.gz -C /usr/local/
echo "export PATH=/usr/local/go/bin:${PATH}" | sudo tee -a $HOME/.profile
source $HOME/.profile
```

Verify Go installation:

```
go version
```





----

<!--
grpc-web

10989  protoc -I=. service.proto compact_formats.proto --js_out=import_style=commonjs:web --grpc-web_out=import_style=typescript,mode=grpcwebtext:web
10991  protoc -I=. service.proto compact_formats.proto darkside.proto --js_out=import_style=commonjs:web --grpc-web_out=import_style=typescript,mode=grpcwebtext:web
 -->


