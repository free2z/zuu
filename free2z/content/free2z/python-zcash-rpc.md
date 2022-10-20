## The Reason

I want to be able to interact with the Zcash blockchain using one of my favorite languages, Python. How to communicate with the Zcash blockchain was not obvious to me for a few years! So, hopefully this will help someone else get started!

## The Result

```python
In [1]: from free2z.client import Client

In [2]: z = Client()

In [3]: z.get_balance?
Signature: z.get_balance(addr: str) -> decimal.Decimal
Docstring: Calls z_getbalance on the addr argument and returns a Decimal.
File:      free2z/client.py
Type:      method

In [4]: z.get_balance("zs1uxr6n9zrqxzh3pzppfl0enf9x3q4wcszsp06ke8w4uc8rsan5pds7uhzqv75qdcqp96zgxh6l6g")
Out[4]: 0.01
```

## The Dependencies

- `zcashd`:
  To talk to the Zcash blockchain with Python, 
  I will be running a [full node](https://zcash.readthedocs.io/en/latest/rtd_pages/zcashd.html).

- `slick-bitcoinrpc`:
  I'll be starting with a cool little library called [slick-bitcoinrpc](https://github.com/barjomet/slick-bitcoinrpc). This 
  tidy little thing can talk to a bitcoin node or a Zcash node right out of the box. It's very flexible; but, perhaps 
  as a side-effect, it doesn't give tools any type information or even an idea of what is available in the API. So, we'll 
  be making a wrapper client with [type hints](https://docs.python.org/3/library/typing.html) that will make it 
  more fun and productive to use from an editor or an interactive session.

### Running a full node

[Refer to the docs](https://zcash.readthedocs.io/en/latest/rtd_pages/zcashd.html) for how to run a full node. This can take a day or two to sync. Perhaps a follow-up to this post might show how to use a 
[light client](https://zcash.readthedocs.io/en/latest/rtd_pages/lightclient_support.html). 
If you're serious about integrating Zcash into your product, you can spin up a permanent node on a VM with >= [4GB of RAM](https://zcash.readthedocs.io/en/latest/rtd_pages/troubleshooting_guide.html) for not too much $$. Note that you'll have to set rpcuser and rpcpassword in your `.zcash/zcash.conf` to turn on the 
[RPC](https://zcash.readthedocs.io/en/latest/rtd_pages/payment_api.html#payment-api) 
[API](https://zcash.readthedocs.io/en/latest/rtd_pages/zig.html#zcash-payment-api)

### Making RPC calls with Python

Once the node is up and running, we can easily make basic calls to the RPC interface with the help of `slick-bitcoinrpc`. To figure out what we can do with this interface, these are my favorite docs: [https://zcash.github.io/rpc/](https://zcash.github.io/rpc/). With these in hand we can easily implement a wrapper client with fancy type hints.


#### to be continued ...

Please fund this page if you would like to see this post completed and a pip-installable package put on PyPI. Even a modest donation of 0.001 ZEC would lift the spirits while providing raw material for the soul.



```py
import os
import random
import decimal
from typing import List


class Client(object):

    def __init__(self) -> None:
        # show special mock stuff
        self._get_rpc()

    def _get_rpc(self):
        from slickrpc import Proxy
        user = os.environ["ZCASH_USER"]
        password = os.environ["ZCASH_PASSWORD"]
        host = os.environ.get("ZCASH_HOST", "127.0.0.1")
        port = os.environ.get("ZCASH_PORT", "8232")
        proto = os.environ.get("ZCASH_PROTO", "http")
        self.rpc = Proxy(f"{proto}://{user}:{password}@{host}:{port}")
        # self.dummy = False

    def new_addr(self) -> str:
        return self.rpc.z_getnewaddress()

    def is_valid(self, addr: str) -> bool:
        return self.rpc.z_validateaddress(addr)

    def get_balance(self, addr: str) -> decimal.Decimal:
        """
        Calls z_getbalance on the addr argument and returns a float.
        """
        return self.rpc.z_getbalance(addr)

    def list(self) -> List[str]:
        return self.rpc.z_listaddresses()

```

Example Usage:

```py
"""
Look in local node to find the latest payments and flip those pages to funded
"""
from django.core.management.base import BaseCommand

from free2z.client import Client
from g12f.models import zPage


class Command(BaseCommand):
    help = 'Checks if zPages are funded'

    def handle(self, *args, **kwargs):
        z = Client()
        unfunded_pages = zPage.objects.filter(is_funded=False)

        funded = 0
        for page in unfunded_pages:
            print(f"checking {page}")
            if z.get_balance(page.free2zaddr) >= 0.01:
                print(f"{page} is funded")
                page.is_funded = True
                page.save()
                funded += 1
        print(f"{funded} pages were funded. Exiting ..")
```