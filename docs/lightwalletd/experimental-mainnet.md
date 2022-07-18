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

Note that we will be installing a lot of powerful tools into our VM
and will be building and running the latest `master` version of lightwalletd
from source https://github.com/zcash/lightwalletd.
For a production server, you probably don't want all of this power installed.
Eventually we'll introduce a minimal container to run things.

> TODO: containerize!!

#### Prereqs to build lightwalletd

##### System prereqs

```
sudo apt install -y build-essential
```

Install Docker (copied from .devcontainer/Dockerfile in free2z repo)

```
sudo apt install -y \
    ca-certificates \
    curl \
    gnupg \
    lsb-release
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
    $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker $USER
# You have to log out of your shell and log back in to be in the group!
```

##### Install Go.

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

---

#### Building lightwalletd

Grab the free2z repo

```
sudo apt install git
git clone https://github.com/free2z/zuu
cd zuu
git checkout metarepo  # TODO: remove once merged
git submodule update --init --recursive
cd zcash/lightwalletd  # master version
```

Now, build lightwalletd:

```
make
```

#### Expose!!

```
sudo apt install certbot ufw
sudo ufw enable
```

```
sudo ufw allow 80/tcp comment 'accept HTTP connections'
```

Forward DNS to your server. In the case we'll be using zuul.free2z.cash.
Once the DNS for the subdomain has propagated, you can generate certificates:

```
sudo certbot certonly --standalone --preferred-challenges http -d zuul.free2z.cash
```

```
sudo ufw allow 9067
```


```
wget https://github.com/fullstorydev/grpcurl/releases/download/v1.7.0/grpcurl_1.7.0_linux_x86_64.tar.gz

tar -xvf grpcurl_1.7.0_linux_x86_64.tar.gz

chmod +x grpcurl

./grpcurl -help
```

Make sure that the port is open and no firewall is block access.

https://stackoverflow.com/a/21068402/177293

Run lightwalletd with options (or create lightwalletd.yml with options):

```
./lightwalletd --tls-cert /path/to/fullchain.pem \
    --tls-key /path/to/privkey.pem \
    --zcash-conf-path /path/to/.zcash/zcash.conf \
    --log-file /path/to/logs/server.log \
    --data-dir /path/to/lightwalletd \
    --grpc-bind-addr 0.0.0.0:9067
```

Now you should be able to get data from the lightwalletd instance using
grpcurl:

```
grpcurl zuul.free2z.cash:9067 cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLatestBlock
```

This should return something like:

```
{
  "height": "1724495",
  "hash": "yZ/M9KdiQeQVWtT3vgOa5jK3TMNh5pvGsfChAQAAAAA="
}
```


----

<!--
grpc-web

10989  protoc -I=. service.proto compact_formats.proto --js_out=import_style=commonjs:web --grpc-web_out=import_style=typescript,mode=grpcwebtext:web
10991  protoc -I=. service.proto compact_formats.proto darkside.proto --js_out=import_style=commonjs:web --grpc-web_out=import_style=typescript,mode=grpcwebtext:web
 -->
