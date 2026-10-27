import decimal
import os
import codecs
import random
from typing import List, TypedDict


class VKAddr(TypedDict):
    """
    {
        "address_type" : "xxxx",
        "type" : "xxxx",
        "address" : "address|DefaultAddress",
    }
    """
    address_type: str
    address: str


def ascii2hex(x: str) -> str:
    return codecs.encode(bytes(x, 'ascii'), 'hex').decode()


def hex2ascii(x: str) -> str:
    return codecs.decode(x, 'hex').decode()


class Client(object):

    def __init__(self) -> None:
        self.dummy = True
        self.rpc = None

        if os.environ.get("ZCASH_USER"):
            self._get_rpc()

    def _get_rpc(self):
        print("Using live node!")
        from slickrpc import Proxy
        # TODO: better
        user = os.environ["ZCASH_USER"]
        password = os.environ["ZCASH_PASSWORD"]
        self.rpc = Proxy(f"http://{user}:{password}@127.0.0.1:8232")
        self.dummy = False

    def new_addr(self) -> str:
        """
        Create a new Sapling address

        https://zcash.github.io/rpc/z_getnewaddress.html
        """
        if self.dummy:
            # not valid though ...
            zaddr = "zs1lm4vumxdpuz08w237n0lpxz490uq5nxasz6mql555f96hql4h7kc3ucf2a42j7mp0slck2uvjjk"
            return ''.join(random.sample(zaddr, len(zaddr)))
            # return zaddr
        return self.rpc.z_getnewaddress()

    def is_valid(self, addr: str) -> bool:
        if self.dummy:
            return True
        return self.rpc.z_validateaddress(addr)

    def get_balance(self, addr: str) -> float:
        """
        Calls z_getbalance on the addr argument and returns a float.
        """
        if self.dummy:
            return 0.0
        return self.rpc.z_getbalance(addr)

    def list_deprecated(self) -> List[str]:
        """
        z_listaddresses
        """
        if self.dummy:
            return []
        return self.rpc.z_listaddresses()

    def list_sapling(self) -> List[str]:
        """
        [{
            'source': 'mnemonic_seed',
            'transparent': {
                'addresses': ['t1bgtrTv2voUY8JxmhpVCM2ysGjsKjV5t6j']
            },
            'sapling': [{
                'zip32KeyPath': "m/32'/133'/2147483647'/0'",
                'addresses': [
                    'zs1lm4vumxdpuz08w237n0lpxz490uq5nxasz6mql555f96hql4h7kc3ucf2a42j7mp0slck2uvjjk'
                ]
            }]
        }]
        """
        dicts = self.rpc.listaddresses()
        l = []
        for d in dicts:
            saps = d.get('sapling', [])
            for s in saps:
                l.extend(s.get('addresses', []))
        return l

    def import_viewing_key(
        self,
        vkey: str,
        # rescan: str = "whenkeyisnew",  # yes no whenkeyisnew
        rescan: str = "no",
        block_height: int = 1730000,
    ) -> VKAddr:
        """
        https://zcash.github.io/rpc/z_importviewingkey.html
        """
        return VKAddr(**self.rpc.z_importviewingkey(vkey, rescan, block_height))

    def recieved_by(self, addr: str) -> List[dict]:
        """
        [{
            'txid': '04b11c78906d6cf94792cabe03c542c47626dae7521c007f2d7eecd10944ab40',
            'amount': 0.01,
            'amountZat': 1000000,
            'memo': 'f600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
            'outindex': 0,
            'confirmations': 2559,
            'blockheight': 1591145,
            'blockindex': 5,
            'blocktime': 1646783796,
            'change': False
        }]
        """
        if self.dummy:
            return [{
                'txid': '04b11c78906d6cf94792cabe03c542c47626dae7521c007f2d7eecd10944ab40',
                'amount': 0.01,
                'amountZat': 1000000,
                'memo': 'f600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
                'outindex': 0,
                'confirmations': 2559,
                'blockheight': 1591145,
                'blockindex': 5,
                'blocktime': 1646783796,
                'change': False
            }]
        return self.rpc.z_listreceivedbyaddress(addr)

    def read_messages(self, addr: str) -> None:
        for tx in self.recieved_by(addr):
            try:
                print(hex2ascii(tx['memo']))
            except UnicodeDecodeError:
                pass

    def get_total_balance(self) -> decimal.Decimal:
        if self.dummy:
            return 0.0
        return decimal.Decimal(self.rpc.z_gettotalbalance()['private'])

    def mergeto(self, addrs: List[str], to: str) -> dict:
        if self.dummy:
            return {
                'remainingUTXOs': 0,
                'remainingTransparentValue': 0.0,
                'remainingNotes': 0,
                'remainingShieldedValue': 0.0,
                'mergingUTXOs': 0,
                'mergingTransparentValue': 0.0,
                'mergingNotes': 1,
                'mergingShieldedValue': 0.011,
                'opid': 'opid-9208b2d3-7e79-4253-9380-d6bb5fca9f20'
            }
        return self.rpc.z_mergetoaddress(addrs, to)


# Select the wallet implementation without replacing this module on disk.
# The legacy client remains the default for CI, local development, and callers
# that do not opt into another adapter. Keep the old ZCASH_BACKEND switch as a
# compatibility alias until its callers move to ZCASHRPC_CLIENT.
_requested_client = os.environ.get("ZCASHRPC_CLIENT")
if _requested_client is None:
    _requested_client = (
        "zallet"
        if os.environ.get("ZCASH_BACKEND") == "zallet"
        else "legacy"
    )

if _requested_client == "legacy":
    pass
elif _requested_client == "wallet_sqlite":
    from zcashrpc.wallet_sqlite_client import Client as Client  # noqa: F811
elif _requested_client == "zallet":
    from zcashrpc.zallet_client import ZalletClient as Client  # noqa: F811
else:
    raise ValueError(
        "invalid ZCASHRPC_CLIENT={!r}; expected one of: legacy, wallet_sqlite, "
        "zallet".format(_requested_client)
    )
