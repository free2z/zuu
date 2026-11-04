"""Sweep the cloud node's balance to the owner's payout address.

If the node's total balance is at least 0.2 ZEC, merge every Sapling address
holding funds into ``to`` below — the owner's unified address (UA).

The 0.2 threshold is a floor, not a target: below it the command returns
without doing anything, so dust does not get swept at a loss to fees.
"""
from django.core.management.base import BaseCommand

from zcashrpc.client import Client

# Historical destinations, kept for provenance. Do NOT re-enable one without
# the owner saying so — this constant is where the money goes.
#   consolidated:
#     to = "zs15kudykglwgaude9v3p90h2xvs9xyzhtn5qnleqx6dszv3n8cmrgu3ge88vwshn228krcyk97e9h"
#   Android:
#     to = "zs1fhtyukrdml9ez256gt0dz8h5xvljg57k9p8kwrxlpnk7f5w00rr35drqzgd5k4pajz4pu8p962d"
#
# Current payout destination: the owner's unified address.
to = "u1dep9q0tvke8q3ky3ah55aj9mh273gy50ghll86cfazqexgwzems736h5vtpf9qr7nvpe4qanamx0a3z0csm822w2uzl68q0memfjlrt4e6226w8muckakn6l800asdgeat7zk00jtz0qrukr75ur2fw4q69smwk7ffldyt9xrshu82gs"


class Command(BaseCommand):
    help = 'Moves Zcash from cloud node'

    def handle(self, *args, **kwargs):
        z = Client()

        if z.get_total_balance() < 0.2:
            return

        # TODO: orchard ;/
        from_addrs = []
        for addr in z.list_sapling():
            if z.get_balance(addr) > 0:
                from_addrs.append(addr)

        #print(from_addrs, to)
        # TODO: orchard ;/
        # ...
        z.mergeto(from_addrs, to)
