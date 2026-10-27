"""``manage.py changepassword`` — Django's, plus the ownership counter.

Issue, raised by the codex adversarial review. A password replaced from
the command line is the same account-ownership event as one replaced through
``/api/emails/change-password`` or an emailed reset token: it is what an
operator runs to hand an account back to its owner, or to take it away from
somebody. Django's built-in command calls ``set_password()`` and ``save()`` and
knows nothing about ``kt_account_epoch``, so without this override the one
credential path an operator reaches for in an incident would be the one that
leaves outstanding key-transparency assertions spendable.

It is an override rather than a signal on ``Creator`` deliberately. A
``pre_save`` hook would have to compare the stored password hash on **every**
save of every account to notice a change — an extra read on the profile-edit
path, on the ledger path, on every admin save — to catch one management command.
Overriding the command puts the cost where the event is.

**The position of ``dj.apps.ktauth`` in ``INSTALLED_APPS`` is what makes this
run at all.** ``get_commands()`` iterates ``reversed(apps.get_app_configs())``
and lets each ``update()`` win, so a command defined twice resolves to the app
**earliest** in the list — the opposite of the intuition. ``ktauth`` is first
for exactly this reason, and ``dj/free2z/settings.py`` says so at the entry. Put
this file in an app that sits after ``django.contrib.auth`` and it is installed,
importable, and completely inert.

``dj/apps/ktauth/tests/test_ownership_events.py`` calls the command and asserts
the counter moved, so the ordering cannot regress silently.
"""

import getpass

from django.contrib.auth import get_user_model
from django.contrib.auth.management.commands.changepassword import (
    Command as BaseCommand,
)
from django.db import transaction

from dj.apps.ktauth.epoch import EVENT_PASSWORD_CHANGE, bump_account_epoch


class Command(BaseCommand):
    help = BaseCommand.help + " Also advances the key-transparency epoch (#1389)."

    def handle(self, *args, **options):
        # Resolved exactly as the base command resolves it -- `--username`, or
        # the invoking OS user -- and read on the same `--database`, so the row
        # counted here is the row it is about to write. Looked up AFTER
        # `super()` so a run that raised `CommandError` (no such user, three
        # failed confirmations) counts nothing.
        user_model = get_user_model()
        with transaction.atomic(using=options["database"]):
            result = super().handle(*args, **options)
            user_id = (
                user_model._default_manager.using(options["database"])
                .filter(
                    **{
                        user_model.USERNAME_FIELD: (
                            options["username"] or getpass.getuser()
                        )
                    }
                )
                .values_list("pk", flat=True)
                .first()
            )
            if user_id is not None:
                bump_account_epoch(
                    user_id,
                    event=EVENT_PASSWORD_CHANGE,
                    using=options["database"],
                )
        return result
