"""The epoch a pending confirmation link is valid at (#1571).

**No backfill, deliberately.** ``ConfirmEmailView`` refuses a row whose stamp
is not the account's current epoch, and ``NULL`` never compares equal to
anything, so every ``Email`` row that exists when this runs has a confirmation
token that stops confirming.

That is the correct direction, and stamping them "current" would be the
opposite. The #1571 chain is: an attacker points the account's (OneToOne)
``Email`` row at their own mailbox, the owner changes their password, and the
emailed link still confirms -- making the attacker the account's recovery
principal. Such a link is pending RIGHT NOW on any account mid-attack, and a
backfill would stamp it at the account's current epoch and hand the attacker
exactly the takeover this change exists to stop, with the platform's blessing.
Raised by the codex adversarial review.

The cost of failing closed instead is one hour wide and self-healing: an
``Email.token`` expires in an hour (``calculate_expiration``), a *confirmed*
address is unaffected because confirmation is a separate column, and anyone
holding an unspent link at deploy time clicks "resend confirmation" on their
profile and gets a fresh, stamped one. Nobody loses an account; some people
click one extra button.

**The unsubscribe landing does not read this column at all**, which is why
this is safe to fail closed: ``Email.token`` doubles as the RFC 8058 one-click
unsubscribe token for a confirmed row, and those links are already in inboxes.
``OptOutEmailView`` resolves them without consulting ``token_epoch``, so
compliance is untouched.

New rows cannot be NULL: ``Email.save()`` fills the stamp from the account when
it is unset, and ``AddEmailView`` sets it deliberately after its own ownership
event so the link it mails survives the bump it raises.
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
        ('emails', '0007_optoutemail_link_token_alter_email_token'),
    ]

    operations = [
        migrations.AddField(
            model_name='email',
            name='token_epoch',
            field=models.PositiveIntegerField(blank=True, null=True),
        ),
    ]
