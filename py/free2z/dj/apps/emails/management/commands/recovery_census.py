"""``manage.py recovery_census`` -- who can get back into their account.

Issue. Measured on production 2026-09-19: 1,676 of 1,766 accounts (95%)
have no ``Email`` row at all, and 137 accounts carry an unusable (``!``)
password. The overlap is the set that was **hard-locked** when X sign-in broke
: no password, no address, and a door that stopped opening.

This is the operator's half of the fix. ``docs/runbooks/account-recovery.md``
is the procedure; this command is the measurement it runs on.

READ-ONLY. ALWAYS.
------------------

There is no ``--apply``, no ``--fix`` and no write path of any kind, and the
default run also executes inside a PostgreSQL ``SET TRANSACTION READ ONLY``
block so the database itself refuses a write even if somebody adds one by
mistake later. Handing an account back to a person is a decision with a
verification step in front of it (the runbook), not something a census does in
bulk.

Run it as a **detached Job**, never ``kubectl exec``: it scans every account
row, and a deploy draining the pod mid-scan kills it with exit 137 that looks
exactly like an OOM. ``docs/agent-operations.md`` has the incident.

What it prints
--------------

Counts, and with ``--list-locked`` a listing. **No email addresses, ever**, and
no other PII: the fields printed are account id, username, join date and active
flag -- the same ones the Django admin's Creator list already shows staff. The
address itself is in the admin for anyone who needs it and does not belong in a
terminal scrollback, a Job log or a pasted ticket.

* ``accounts``: total, active.
* ``recovery``: the headline. ``recoverable`` is the only good state -- a
  confirmed address that is not on the opt-out list, i.e. one that
  ``/api/emails/reset-password`` would really mail. Everything else is a
  bucket of not-recoverable, split by *why*.
* ``hard_locked``: not recoverable **and** no usable password. These are the
  137. A linked identity is the only door, and nothing restores it if that door
  breaks. Split by whether any login-capable identity exists at all -- social,
  legacy Twitter **or Zcash wallet** -- because an account in
  ``no_login_method`` cannot be reached by fixing  -- and, having no
  identity to prove ownership with, is refused by the runbook's §3 gate too.
* ``passwords.empty_hash``: accounts whose stored hash is the empty string.
  Django calls that *usable* while nothing can ever match it, so they are told
  they have a password and then asked for it. Should be zero; migration 0081
  converted the ones that existed.
* ``suppressed``: accounts whose address is on the ``OptOutEmail`` list. This
  is the trap worth knowing about: ``send_confirmation_email`` returns early
  for a suppressed address, so the account holder can add it, get a cheerful
  201, and never receive anything. Resending does not help. Forever.
* ``login_methods``: legacy ``TwitterProfile`` rows with ``allow_login``,
  ``SocialIdentity`` rows by provider, and ``ZcashIdentity`` rows. **Three**
  separate login families; no one of them superseded the others, and a census
  that knows about only some of them invents lockouts that do not exist.

``--username`` additionally prints, per family, whether a linked identity is
**current** -- ``linked_at_epoch == kt_account_epoch``, the test
``dj.apps.ktauth.credentials.identity_can_authenticate`` applies. It is there
for one reason: the runbook's verification step must not accept control of a
STALE identity as proof of ownership, because a stale identity is exactly what
an attacker who linked one during a stolen session is left holding after the
owner resets. On a passwordless account the login path does not refuse a stale
identity either (the  exemption), so the operator, not the code, is the
only check.
* ``creator_email_column``: accounts with a value in ``Creator.email`` (the
  ``AbstractUser`` column) and no confirmed ``Email`` row. **These people
  probably believe they gave us an address.** The profile PATCH serializer
  accepts ``email`` into that column, nothing ever validates or confirms it,
  and the password-reset lookup does not read it. It is a lead for support,
  never a credential.
"""

import json

from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import is_password_usable
from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction
from django.db.models import Count, Exists, F, OuterRef, Q
from django.utils import timezone

from dj.apps.emails.models import Email, OptOutEmail
from dj.apps.otp.models import OTPSecret
from dj.apps.social.models import SocialIdentity
from dj.apps.twitter.models import TwitterProfile
from dj.apps.zauth.models import ZcashIdentity


def has_active_totp_for(user_id):
    """``dj.apps.otp.utils.has_active_totp``, by id rather than by instance.

    The util takes a request user and short-circuits on ``is_authenticated``,
    which a management command has no notion of; the underlying question is
    just whether an active ``OTPSecret`` row exists.
    """
    return OTPSecret.objects.filter(user_id=user_id, is_active=True).exists()


def _usable(encoded):
    """Exactly what ``Creator.has_usable_password()`` answers, from a string.

    **Django's own predicate, deliberately** (codex adversarial review). A
    hand-rolled ``bool(encoded) and not encoded.startswith('!')`` looks
    equivalent and is not: for an empty stored hash Django says *usable* and
    the hand-rolled version says *unusable*. That one disagreement is the worst
    possible kind, because it puts support and the account holder in different
    worlds -- the census would call the account hard-locked while
    ``/api/emails/recovery-status`` and ``ChangePasswordSerializer`` both treat
    it as having a password and demand an ``old_password`` nobody can produce.

    An empty hash is still a broken account; it is counted separately
    (``passwords.empty_hash``) rather than silently reclassified, so the
    anomaly is visible instead of being folded into a number that means
    something else.

    Calling it on a string rather than a model instance is what lets the census
    answer for every account without instantiating one object per row.
    """
    return is_password_usable(encoded)


def _login_families(queryset):
    """Annotate every login family that can get somebody into an account.

    **Three of them, not two** (codex adversarial review). ``dj.apps.zauth``
    signs people in by having them sign a server-issued challenge with a Zcash
    t-address, and a wallet-only account has no password and no email by
    design. Leaving ``ZcashIdentity`` out put exactly those accounts in
    ``hard_locked.no_login_method`` -- the bucket nothing can rescue -- when in fact their wallet login works
    fine and support should touch nothing.
    """
    return queryset.annotate(
        has_social_identity=Exists(
            SocialIdentity.objects.filter(creator_id=OuterRef('pk')),
        ),
        has_twitter_login=Exists(
            TwitterProfile.objects.filter(
                creator_id=OuterRef('pk'), allow_login=True,
            ),
        ),
        has_zcash_identity=Exists(
            ZcashIdentity.objects.filter(creator_id=OuterRef('pk')),
        ),
    )


def _identity_inventory(user_id, account_epoch):
    """EVERY linked identity, listed one by one, each with its own verdict.

    "Current" is ``linked_at_epoch == kt_account_epoch``, the test
    ``dj.apps.ktauth.credentials.identity_can_authenticate`` applies. A stale
    identity was linked before an ownership event that evicted whoever held the
    account -- which is precisely the shape of an attacker-planted identity, and
    the row cannot tell that apart from one the owner linked and then reset
    around.

    **One row per identity, never a per-family boolean** (codex adversarial
    review, round 2). An earlier version answered ``social_identity_current``
    with ``any()`` over the family, which collapses exactly the case that
    matters: an attacker's X identity goes stale at the owner's password reset,
    the owner later links Google, and the family-level answer flips back to
    *current* with no warning. An operator checking that boolean would then
    accept a nonce from the attacker's revoked X account. Support must match
    the identity that actually supplied the proof, so each is listed with its
    provider and its **stable** uid -- never the handle, which anyone can
    rename to.

    **``current`` means "not revoked". It never means "is the owner"**
    (independent review, round 3). Linking an identity does not bump the
    account epoch, so an identity an attacker plants during a stolen session
    reads ``CURRENT`` from the moment it is written. That is why every entry
    also carries a wall-clock timestamp.

    **That timestamp is ``row_created_at``, and it is NOT the time the identity
    was attached to this account** (codex adversarial review, round 4). It was
    briefly named ``linked_at``, which was a lie of exactly the kind this
    command exists to prevent: ``TwitterProfile.creator`` is nullable, an
    interrupted OAuth flow leaves an orphaned row, and
    ``dj.apps.twitter.views`` adopts one by writing
    ``update_fields=['creator', 'linked_at_epoch']`` -- ``created_at`` is
    ``auto_now_add`` and is never touched. So an attacker holding an old
    orphaned profile can attach it today and the row still reports a date from
    years ago.

    **No attachment time is recorded anywhere**, so the signal is
    one-directional and the report says so:

    * a **recent** timestamp bounds the association from above -- the row
      itself is new, so the link cannot be older. That is real evidence, and
      against the claimant when it lands near the claimed lockout;
    * an **old** timestamp proves nothing at all. The row is old; the
      association may be minutes old.

    Recording a true attachment time needs a column and a migration; until
    then an operator must not read an old date as reassurance.

    See ``docs/runbooks/account-recovery.md`` §3a.
    """
    identities = []
    for row in SocialIdentity.objects.filter(creator_id=user_id).values(
        'provider', 'provider_uid', 'linked_at_epoch', 'verified_at',
    ):
        identities.append({
            'family': 'social_identity',
            'provider': row['provider'],
            'stable_uid': row['provider_uid'],
            'linked_at_epoch': row['linked_at_epoch'],
            'row_created_at': row['verified_at'],
        })
    for row in TwitterProfile.objects.filter(
        creator_id=user_id, allow_login=True,
    ).values('twitter_id', 'linked_at_epoch', 'created_at'):
        identities.append({
            'family': 'twitter_login',
            'provider': 'twitter-legacy',
            'stable_uid': row['twitter_id'],
            'linked_at_epoch': row['linked_at_epoch'],
            'row_created_at': row['created_at'],
        })
    for row in ZcashIdentity.objects.filter(creator_id=user_id).values(
        'zcash_address', 'linked_at_epoch', 'created_at',
    ):
        identities.append({
            'family': 'zcash_identity',
            'provider': 'zcash',
            'stable_uid': row['zcash_address'],
            'linked_at_epoch': row['linked_at_epoch'],
            'row_created_at': row['created_at'],
        })
    for identity in identities:
        identity['current'] = identity['linked_at_epoch'] == account_epoch
        identity['row_created_at'] = (
            identity['row_created_at'].isoformat()
            if identity['row_created_at'] is not None else None
        )
    return sorted(
        identities, key=lambda i: (i['family'], str(i['stable_uid']))
    )


class Command(BaseCommand):
    help = (
        "Account-recovery census (#1980): who has a working way back into "
        "their account and who does not. Read-only; no --apply exists."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--json", action="store_true", help="Emit one JSON document."
        )
        parser.add_argument(
            "--list-locked",
            action="store_true",
            help=(
                "List the hard-locked accounts (id, username, date_joined, "
                "is_active, which login families exist). Staff-visible "
                "fields only -- never an email address."
            ),
        )
        parser.add_argument(
            "--username",
            help=(
                "Report one named account's recovery posture instead of the "
                "whole census. Exact match, the way the account is stored."
            ),
        )

    def handle(self, *args, **options):
        with transaction.atomic():
            if connection.vendor == "postgresql":
                with connection.cursor() as cursor:
                    cursor.execute("SET TRANSACTION READ ONLY")
            if options["username"]:
                report = self._one_account(options["username"])
            else:
                report = self._census(list_locked=options["list_locked"])

        if options["json"]:
            self.stdout.write(json.dumps(report, indent=2, sort_keys=True))
        else:
            self._print(report)

    # ------------------------------------------------------------------
    # Shared predicates. Defined once because the census and the
    # single-account report MUST agree: a runbook that reads one number from
    # the summary and a different rule from the detail view is how an operator
    # ends up "fixing" an account that was never broken.
    # ------------------------------------------------------------------

    @staticmethod
    def _suppressed_addresses():
        """The set of opted-out addresses that some account still holds.

        Unsubscribing DELETEs the ``Email`` row, so what comes back is only the
        OVERLAP -- an address re-added after an opt-out, or one an admin put on
        the list by hand -- and is normally tiny. Small enough to materialise,
        and materialising it keeps the per-account check out of a row-by-row
        query.

        The opt-out list itself is NOT materialised. It is the one table here
        with no ceiling on it (every unsubscribe ever, forever), and pulling it
        into Python to build an ``IN (...)`` of every opted-out address is the
        kind of thing that runs fine for a year and then takes the support tool
        out on the day it is needed. ``values('email')`` keeps it a subquery.
        """
        return set(
            Email.objects.filter(
                email__in=OptOutEmail.objects.values('email'),
            ).values_list('email', flat=True)
        )

    # ------------------------------------------------------------------

    def _census(self, *, list_locked):
        Creator = get_user_model()
        accounts = Creator._default_manager.all()
        now = timezone.now()
        suppressed = self._suppressed_addresses()

        emails = Email.objects.all()
        confirmed_user_ids = set(
            emails.filter(confirmed_at__isnull=False)
            .exclude(email__in=suppressed)
            .values_list('user_id', flat=True)
        )
        suppressed_user_ids = set(
            emails.filter(email__in=suppressed).values_list('user_id', flat=True)
        )
        pending_user_ids = set(
            emails.filter(
                confirmed_at__isnull=True,
                expires_at__gt=now,
                # Operator classification includes token epoch validity;
                # public recovery-status hides it to avoid a quota oracle.
                # The  revocation check (codex adversarial
                # review). `ConfirmEmailView` filters on
                # `token_epoch=F('user__kt_account_epoch')`, so a link minted
                # before a password change is already dead however much time
                # its `expires_at` still claims. Counting it as "pending"
                # would tell support the user only has to click a link that
                # 404s.
                token_epoch=F('user__kt_account_epoch'),
            )
            .exclude(email__in=suppressed)
            .values_list('user_id', flat=True)
        )
        any_email_user_ids = set(emails.values_list('user_id', flat=True))

        rows = list(
            _login_families(accounts).values(
                'pk', 'username', 'date_joined', 'is_active', 'password_set',
                'password', 'has_social_identity', 'has_twitter_login',
                'has_zcash_identity',
            )
        )
        empty_hashes = 0
        for row in rows:
            row['has_usable_password'] = _usable(row['password'])
            if not row['password']:
                empty_hashes += 1
            # Never carry the hash past the classification. It is not needed
            # again, it must never reach a report, a log or a paste.
            del row['password']

        recoverable = 0
        buckets = {
            'suppressed_address': 0,
            'unconfirmed_address': 0,
            'expired_or_stale_address': 0,
            'no_address_at_all': 0,
        }
        hard_locked = {'total': 0, 'login_identity_available': 0,
                       'no_login_method': 0}
        locked_listing = []

        for row in rows:
            pk = row['pk']
            if pk in confirmed_user_ids:
                recoverable += 1
                continue
            if pk in suppressed_user_ids:
                buckets['suppressed_address'] += 1
            elif pk in pending_user_ids:
                buckets['unconfirmed_address'] += 1
            elif pk in any_email_user_ids:
                buckets['expired_or_stale_address'] += 1
            else:
                buckets['no_address_at_all'] += 1

            if row['has_usable_password']:
                continue
            hard_locked['total'] += 1
            # All THREE login families, not two. A wallet-only zauth account
            # signs in by signing a challenge and needs no password and no
            # address by design; omitting it filed those accounts under
            # "nothing can reach this person" and sent support at a manual
            # password handover they did not need (codex adversarial review).
            reachable = (
                row['has_social_identity']
                or row['has_twitter_login']
                or row['has_zcash_identity']
            )
            if reachable:
                hard_locked['login_identity_available'] += 1
            else:
                hard_locked['no_login_method'] += 1
            if list_locked:
                locked_listing.append({
                    'id': pk,
                    'username': row['username'],
                    'date_joined': row['date_joined'].isoformat(),
                    'is_active': row['is_active'],
                    'social_identity': bool(row['has_social_identity']),
                    'twitter_login': bool(row['has_twitter_login']),
                    'zcash_identity': bool(row['has_zcash_identity']),
                })

        report = {
            'accounts': {
                'total': len(rows),
                'active': sum(1 for row in rows if row['is_active']),
            },
            'recovery': {
                'recoverable': recoverable,
                'not_recoverable': len(rows) - recoverable,
                **buckets,
            },
            'hard_locked': hard_locked,
            'passwords': {
                'usable': sum(1 for row in rows if row['has_usable_password']),
                'unusable': sum(
                    1 for row in rows if not row['has_usable_password']
                ),
                # The stored hash is authoritative; `Creator.password_set` is a
                # cached flag that g12f migration 0081 backfilled only for rows
                # whose password was the EMPTY STRING. An account made unusable
                # before that column existed still reads `password_set=True`
                # over a `!` hash -- so the UI tells the user they have a
                # password while `ChangePasswordSerializer`, which branches on
                # the hash, waives `old_password`. Any nonzero number here is a
                # population that sees a wrong answer from
                # `/api/emails/password-is-set`. `/api/emails/recovery-status`
                # deliberately reports the hash instead.
                'flag_disagrees_with_hash': sum(
                    1 for row in rows
                    if bool(row['password_set']) != row['has_usable_password']
                ),
                # An EMPTY stored hash, which Django counts as usable
                # (`is_password_usable('')` is True) even though no password
                # can ever match it. g12f migration 0081 was supposed to
                # convert every one of these; a nonzero number here means some
                # survived or were created since, and each is an account that
                # is told it has a password, is asked for it, and cannot
                # proceed. Counted rather than reclassified, so the anomaly is
                # visible instead of hidden inside `unusable`.
                'empty_hash': empty_hashes,
            },
            'suppressed': {
                'opt_out_rows': OptOutEmail.objects.count(),
                'accounts_holding_a_suppressed_address': len(
                    suppressed_user_ids
                ),
            },
            'login_methods': {
                'twitter_profiles': TwitterProfile.objects.count(),
                'twitter_profiles_allow_login': TwitterProfile.objects.filter(
                    allow_login=True,
                ).count(),
                'social_identities_by_provider': dict(
                    SocialIdentity.objects.values_list('provider')
                    .annotate(n=Count('pk'))
                    .values_list('provider', 'n')
                ),
                'zcash_identities': ZcashIdentity.objects.count(),
            },
            # Not a credential. See the module docstring.
            'creator_email_column': {
                # Subtracts accounts with ANY confirmed row, not
                # `confirmed_user_ids` -- that set already excludes suppressed
                # addresses, so using it filed an account whose confirmed row
                # happens to be suppressed under a name saying it has no
                # confirmed row (independent review, round 3). Suppression is
                # reported in its own section; this lead list is about whether
                # a confirmed row exists at all.
                'set_but_no_confirmed_email_row': accounts.exclude(
                    Q(email='') | Q(email__isnull=True),
                ).exclude(
                    pk__in=emails.filter(
                        confirmed_at__isnull=False,
                    ).values('user_id'),
                ).count(),
            },
        }
        if list_locked:
            report['locked'] = sorted(
                locked_listing, key=lambda entry: entry['id']
            )
        return report

    def _one_account(self, username):
        Creator = get_user_model()
        row = (
            Creator._default_manager.filter(username=username)
            .values(
                'pk', 'username', 'date_joined', 'is_active', 'password_set',
                'password', 'kt_account_epoch',
            )
            .first()
        )
        if row is None:
            raise CommandError(f"No account with username {username!r}")
        has_usable_password = _usable(row.pop('password'))
        identities = _identity_inventory(row['pk'], row['kt_account_epoch'])

        email = (
            Email.objects.filter(user_id=row['pk'])
            .values('email', 'confirmed_at', 'expires_at', 'token_epoch')
            .first()
        )
        suppressed = bool(
            email
            and OptOutEmail.objects.filter(email=email['email']).exists()
        )
        confirmed = bool(email and email['confirmed_at'] is not None)
        pending = bool(
            email
            and not confirmed
            # `_census`'s `pending_user_ids` excludes suppressed addresses and
            # this did not, so the module docstring's claim that the summary
            # and the detail view MUST agree was not literally true
            # (independent review, round 3). A suppressed address is reported
            # in its own field and classified into its own bucket; it is not
            # also "pending", because no confirmation was ever delivered.
            and not suppressed
            and email['expires_at'] > timezone.now()
            # Same  revocation ConfirmEmailView enforces.
            and email['token_epoch'] == row['kt_account_epoch']
        )
        can_recover = confirmed and not suppressed
        # Counts, not a verdict. `stale_identities` is the number support must
        # actually look at: it is nonzero whenever ANY linked identity predates
        # an ownership event, even if a newer one alongside it is current --
        # which is the case a per-family `any()` used to hide.
        stale_identities = sum(1 for i in identities if not i['current'])
        return {
            'account': {
                'id': row['pk'],
                'username': row['username'],
                'date_joined': row['date_joined'].isoformat(),
                'is_active': row['is_active'],
            },
            'can_recover': can_recover,
            'email_on_file': email is not None,
            'email_confirmed': confirmed,
            'email_pending': pending,
            'email_suppressed': suppressed,
            # The hash, which is what actually governs whether the account can
            # sign in and whether `old_password` is required. The cached flag
            # is printed beside it precisely so an operator sees a
            # disagreement rather than trusting whichever one they happened to
            # look at.
            'password_set': has_usable_password,
            'password_set_flag': bool(row['password_set']),
            # Redeeming a reset link, changing a password and signing in all
            # demand a current code from an enrolled account, and the §3b
            # password handover does NOT clear it. Support has to know before
            # promising anybody access.
            'mfa_required': has_active_totp_for(row['pk']),
            'account_epoch': row['kt_account_epoch'],
            'identities': identities,
            'stale_identities': stale_identities,
            'hard_locked': (not can_recover) and not has_usable_password,
        }

    # ------------------------------------------------------------------

    def _print(self, report):
        if 'account' in report:
            account = report['account']
            self.stdout.write(
                f"{account['username']} (id {account['id']}, joined "
                f"{account['date_joined']}, "
                f"{'active' if account['is_active'] else 'INACTIVE'})"
            )
            for key in (
                'can_recover', 'email_on_file', 'email_confirmed',
                'email_pending', 'email_suppressed', 'password_set',
                'password_set_flag', 'mfa_required', 'account_epoch',
                'stale_identities', 'hard_locked',
            ):
                self.stdout.write(f"  {key:<24} {report[key]}")
            for identity in report['identities']:
                # Per identity, never per family. A current Google link
                # alongside a revoked X link must not make the X link look
                # acceptable -- support matches the one that supplied the
                # proof, by its STABLE uid.
                verdict = 'CURRENT' if identity['current'] else 'STALE'
                self.stdout.write(
                    f"  identity {verdict:<8} {identity['provider']}"
                    f" uid={identity['stable_uid']}"
                    f" row_created_at={identity['row_created_at']}"
                    f" linked_at_epoch={identity['linked_at_epoch']}"
                )
            if not report['identities']:
                # Say it out loud. §3a's revocation gate is the runbook's
                # first line of defence, and for an account with NO identity
                # it has nothing to bind to -- so an operator reading a report
                # with no identity lines and `stale_identities 0` could take
                # the precondition as satisfied. It is not satisfied; it is
                # inapplicable, and that is a reason to escalate rather than
                # to proceed. Reproduced by the round-3 reviewer against
                # exactly the `hard_locked.no_login_method` population §3
                # exists to serve.
                self.stdout.write(
                    "  NO LINKED IDENTITIES -- §3a's revocation check has "
                    "nothing to evaluate. That is NOT the same as passing it. "
                    "There is no self-service proof of ownership for this "
                    "account; escalate to the owner. Runbook §3a."
                )
            if any(identity['current'] for identity in report['identities']):
                # Printed whenever ANY identity is CURRENT -- it used to be
                # suppressed as soon as a sibling was STALE, which is exactly
                # the mixed case that most needs it (round 6). That account has
                # already demonstrated an ownership event; the operator refuses
                # the stale identity, turns to the current one, and the single
                # sentence written to stop them reading CURRENT as a green
                # light was the one the report chose not to print.
                self.stdout.write(
                    "  NOTE: CURRENT means 'not revoked', never 'is the "
                    "owner'. Linking does not bump the epoch, so an identity "
                    "planted during a stolen session reads CURRENT from "
                    "creation. row_created_at bounds the association only from "
                    "ABOVE: a RECENT date is evidence against the "
                    "claimant; an OLD date proves nothing, because an "
                    "orphaned row can be adopted today without it "
                    "moving."
                )
            if report['stale_identities']:
                # The HIGH finding from the codex adversarial review. A stale
                # identity predates an ownership event, which is the exact
                # shape of one an attacker planted during a stolen session.
                # Control of it is not proof of ownership, and on a
                # passwordless account the login path does NOT refuse it
                # either (the  exemption), so it is also not proof that
                # the real owner is locked out.
                self.stdout.write(
                    f"  WARNING: {report['stale_identities']} linked "
                    "identity/identities are STALE -- linked before an "
                    "ownership event that evicted whoever held this account. "
                    "Do NOT accept control of a STALE one as proof of "
                    "ownership, even if another is CURRENT. Runbook §3a."
                )
            if report['mfa_required']:
                self.stdout.write(
                    "  WARNING: MFA is enrolled. A reset link, a password "
                    "change and a sign-in all need a current authenticator "
                    "code, and so does every identity login. Support does "
                    "NOT hand over or remove MFA on this account -- a lost "
                    "factor is an owner escalation. Runbook §3 gate, §3e."
                )
            if report['password_set'] != report['password_set_flag']:
                self.stdout.write(
                    "  NOTE: the cached password_set flag disagrees with the "
                    "stored hash. The hash wins. /api/emails/password-is-set "
                    "is showing this user the wrong answer."
                )
            if report['email_suppressed']:
                self.stdout.write(
                    "  NOTE: this address is on the opt-out list. Adding or "
                    "resending sends NOTHING. See the runbook."
                )
            return

        for section, body in report.items():
            if section == 'locked':
                continue
            self.stdout.write(section)
            for key, value in body.items():
                self.stdout.write(f"  {key:<42} {value}")
        locked = report.get('locked')
        if locked is not None:
            # Its own header. Without it the listing lines indent straight off
            # the end of whichever section happened to print last and read as
            # part of it.
            self.stdout.write(f"locked ({len(locked)})")
        for entry in locked or []:
            self.stdout.write(
                f"  locked id={entry['id']} username={entry['username']} "
                f"joined={entry['date_joined']} "
                f"active={entry['is_active']} "
                f"social_identity={entry['social_identity']} "
                f"twitter_login={entry['twitter_login']} "
                f"zcash_identity={entry['zcash_identity']}"
            )
