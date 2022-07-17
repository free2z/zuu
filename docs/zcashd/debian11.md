## Debian 11

One of the easiest ways to run `zcashd` is using a Debian 11 VM
from any cloud provider. Create the VM and login as a non-root user who has
`sudo`. Installing and securing the VM is out-of-scope for this guide.
You don't need any external ports open to run your full node.

### Installation

[Update your packages and install zcash](https://zcash.readthedocs.io/en/latest/rtd_pages/install_debian_bin_packages.html)

```
sudo apt-get update && sudo apt-get install apt-transport-https wget gnupg2
```

```
wget -qO - https://apt.z.cash/zcash.asc | gpg --import
gpg --export 3FE63B67F85EA808DE9B880E6DEF3BAF272766C0 | sudo apt-key add -
```

Following the "Bullseye" recipe (Bullseye is the codename for Debian 11).

```
echo "deb [arch=amd64] https://apt.z.cash/ bullseye main" | sudo tee /etc/apt/sources.list.d/zcash.list
```

```
sudo apt-get update && sudo apt-get install zcash
```

```
zcash-fetch-params
```

---

## Configure and run

`zcashd` needs a configuration file. Often this will live at
`$HOME/.zcash/zcash.conf`. Let's add one.

```
mkdir ~/.zcash
touch ~/.zcash/zcash.conf
```

In this case, we will just be using the wallet features and possibly the
RPC interface later. So, we'll leave all of the parameters to the default.
If you want to run a lightwalletd, you'll want to start the node with
different parameters.
See the [lightwalletd guide](../lightwalletd/experimental-mainnet.md)

Now, run the server with:

```
zcashd -daemon
```

Since we didn't set up any RPC,
the only way to interact with the wallet features of the node is to
use `zcash-cli`. To get a list of commands run:

```
zcash-cli help
```
