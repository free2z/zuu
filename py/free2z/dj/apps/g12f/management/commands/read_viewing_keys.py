"""
Go through all pages with viewingkeys and record

Not to be run:

https://free2z.cash/saying-goodbye-to-viewing-key-features-for-now
"""
import json
import codecs
from decimal import Decimal
from datetime import timedelta

from django.core.management.base import BaseCommand
from django.utils import timezone
# from django.db import transaction

from zcashrpc.client import Client
from dj.apps.g12f.models.viewed import ViewedTransaction
from dj.apps.g12f.models.poll import Poll
from dj.apps.g12f.models.comment import PageComment
from dj.apps.g12f.models import zPage


def get_memo(tx):
    memo = tx.get('memo', "")
    try:
        ascii_memo = codecs.decode(
            memo, 'hex'
        ).decode().replace("\x00", "")
    except:
        print(f"could not decode {memo}")
        ascii_memo = ""
    return ascii_memo


class Command(BaseCommand):
    help = 'Syncs txs from node to db'

    def handle(self, *args, **kwargs):
        z = Client()

        # Only try every 5 minutes after initial import
        recent = timezone.now() - timedelta(minutes=5)

        for zp in zPage.objects.exclude(
            viewing_key="",
        ).exclude(
            viewing_key__isnull=True
        ).exclude(
            vk_updated_at__gte=recent
        ):
            print("Importing configured viewing key")
            # bump timestamp, not updated_at
            zp.vk_updated_at = timezone.now()
            zp.save(update_fields=['vk_updated_at'])

            try:
                vkaddr = z.import_viewing_key(zp.viewing_key)
            except Exception as exc:
                # The node may echo the rejected viewing key in its exception.
                print("Could not import configured viewing key")
                # TODO; where is the elegance?
                if "Invalid viewing key" in str(exc):
                    zp.viewing_key = ""
                    zp.save(update_fields=['viewing_key'])
                continue

            if zp.p2paddr != vkaddr['address']:
                print("p2paddr and vkaddr do not match!")
                continue

            for tx in z.recieved_by(vkaddr['address']):

                txid = tx.get('txid')
                if not txid:
                    print("No txid?", tx)
                    continue

                amount = Decimal(tx['amount']).quantize(Decimal("1.00001000"))
                memo = get_memo(tx)

                # Save the ViewedTransaction
                transaction, created = ViewedTransaction.objects.get_or_create(
                    txid=txid
                )
                transaction.zpage = zp
                transaction.memo = memo
                transaction.amount = amount
                transaction.viewing_key = zp.viewing_key
                transaction.address = zp.p2paddr
                transaction.block_height = tx.get('blockheight', 0)
                transaction.block_time = tx.get('blocktime', 0)
                transaction.save()

                if not created:
                    print("Already had transaction!")
                    continue

                try:
                    print(f"loading json: {memo}")
                    json_memo = json.loads(memo)
                except Exception as e:
                    print(e)
                    print(f"could not load json: {memo}")
                    json_memo = {}

                # must be the same page - for redundant VKs on different page
                pid = json_memo.get('id')
                if pid != zp.free2zaddr:
                    continue

                try:
                    poll = Poll.objects.get(zpage=zp)
                except Poll.DoesNotExist:
                    print("No Poll!")
                    continue

                # Now the Poll!
                option = json_memo.get('option')
                # TODO: figure out how to do this eleganntly without ifs
                # total_attr = f"option{option}_total"
                # votes = f"option{option}_votes"
                # !!!!
                # Poll.cache_votes()

                if option == "1":
                    poll.option1_total += amount
                    poll.option1_votes += 1

                if option == "2":
                    poll.option2_total += amount
                    poll.option2_votes += 1

                if option == "3":
                    poll.option3_total += amount
                    poll.option3_votes += 1

                if option == "4":
                    poll.option4_total += amount
                    poll.option4_votes += 1

                if option == "5":
                    poll.option5_total += amount
                    poll.option5_votes += 1

                print("Saving poll!")
                poll.save()
