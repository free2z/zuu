"""Record the epoch each linked identity was linked at (#1574).

**There is deliberately NO backfill, and that is the security decision in this
file.** The obvious one -- stamp every existing row with its account's current
epoch -- looks like a courtesy and is the opposite: an identity an attacker
planted before the owner's password change is exactly the credential this
change exists to neutralise, and it is still linked precisely BECAUSE the
#1574 hole let it survive that event. Stamping it "current" would launder it
into a credential the new check explicitly trusts, permanently. Raised by the
codex adversarial review, which called it the riskiest line in the diff.

So every existing row keeps the column default, ``1``:

* an account that has never had an ownership event is AT epoch 1, so its
  identities match and nothing changes -- the overwhelming majority, since
  ``kt_account_epoch`` only moves on the events ``dj.apps.ktauth.epoch``
  enumerates;
* an account **past** epoch 1 has had an ownership event, which is the exact
  population where a planted identity may have outlived one. Its identities
  are suspended and the owner reconnects them in one click from a session that
  now requires the current password. That is not a regrettable side effect of
  skipping the backfill; it is the property #1574 asks for, applied to the
  history as well as to the future.
* an account with no usable password is exempt from the check entirely, so a
  Zcash-only or social-only creator cannot be locked out by this (#1354,
  #1602).

``db_default`` matters for a different reason -- see the field definition:
``migrate`` runs before the pods roll, and without it the still-running old
pods would take a NOT NULL violation on every new link.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    # NO dependency on `g12f`, deliberately. This column needs no
    # historical `Creator` model (there is no data migration -- see the
    # module docstring), and declaring one anyway would put this node
    # inside g12f's migration plan. `g12f/test_zpage_multilingual.py`
    # and `test_zpage_variants.py` drive `MigrationExecutor.migrate()`
    # backwards to a g12f node and then forward to g12f's leaf: a
    # dependent node in another app is UNAPPLIED by the first step and
    # never re-applied by the second, so the column silently vanishes
    # for the rest of the pytest session and every later test that
    # touches it dies with `column ... does not exist`. Cost one
    # afternoon; it looked exactly like a flaky threading bug.
    dependencies = [
        ('twitter', '0005_alter_twitterprofile_creator'),
    ]

    operations = [
        migrations.AddField(
            model_name='twitterprofile',
            name='linked_at_epoch',
            field=models.PositiveIntegerField(db_default=1, default=1, editable=False, help_text='Creator.kt_account_epoch when this profile was linked. A login through it is refused once the account has moved past it.'),
        ),
    ]
