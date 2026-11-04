"""Link a Stripe checkout to the SDK purchase intent it pays (#2239, PU1).

One nullable column, ``ztripe_checkoutintent.purchase_intent_id``, with its
foreign key and index. Additive and mixed-fleet safe: a pod on the previous
release selects and inserts ``CheckoutIntent`` by its own column list, so it
never reads the column and its inserts leave it NULL -- exactly what a web
wallet checkout carries on the new release too. Fulfilment treats NULL as
before; a purchase intent whose webhook an old pod fulfilled is caught up
when it is next read (``purchases.services.heal_card_intent``).

Locks: ``ADD COLUMN`` of a nullable column without a default is a catalog-
only change under a brief ACCESS EXCLUSIVE lock; the FK takes SHARE ROW
EXCLUSIVE on both tables and validates instantly (every value is NULL); the
index build blocks writes to ``ztripe_checkoutintent`` for the length of a
scan of a small table. ``lock_timeout`` makes a queue behind a long
transaction a fast, retryable ``migrate`` failure instead of a wedged deploy.
"""

import django.db.models.deletion
from django.db import migrations, models

LOCK_TIMEOUT = '10s'


def set_lock_timeout(apps, schema_editor):
    if schema_editor.connection.vendor != 'postgresql':
        return
    schema_editor.execute(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'")


class Migration(migrations.Migration):

    dependencies = [
        ('purchases', '0001_initial'),
        ('ztripe', '0002_checkoutintent_checkoutfulfillmentaudit_and_more'),
    ]

    operations = [
        migrations.RunPython(set_lock_timeout, migrations.RunPython.noop),
        migrations.AddField(
            model_name='checkoutintent',
            name='purchase_intent',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name='checkout_intents', to='purchases.purchaseintent'),
        ),
    ]
