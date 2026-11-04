from decimal import Decimal
from datetime import timedelta

from django.utils import timezone
from django.db import models, router, transaction
from django.core.validators import MinValueValidator
from django.contrib.auth.models import AbstractUser
from django.contrib.contenttypes.models import ContentType
from django.contrib.postgres.functions import RandomUUID
from django.db.models import QuerySet
from django.db.models.functions import Coalesce, Lower
from django.utils.crypto import salted_hmac

import markdown2

from dj.apps.g12f.branding import default_logo_url
from dj.apps.g12f.validators import validate_zcash_address
from dj.apps.uploads.models import GenericFile

# The one constant, imported rather than repeated: `epoch.py` owns the value
# and the reason it is 1 rather than 0.
from dj.apps.ktauth.epoch import INITIAL_ACCOUNT_EPOCH


class _ActiveFansCount(Coalesce):
    """``Coalesce(Subquery(...), 0)`` that stays out of the ``GROUP BY``.

    Django puts every selected non-aggregate expression into ``GROUP BY``.
    For a correlated subquery that is both unnecessary and expensive: the
    subquery is functionally dependent on ``g12f_creator.id``, which is always
    in the group key of a Creator queryset, so grouping by it adds nothing --
    but it makes Postgres evaluate the subquery once per *pre-aggregation*
    row. On the directory query that means once per (creator, zPage) pair
    rather than once per creator: 45.6 ms instead of 9.9 ms at 300 creators /
    1.8k pages, and the gap widens with the number of published pages.

    Returning ``[]`` says "I contribute no grouping columns", which is exactly
    true here. It relies on the outer queryset grouping by the Creator pk --
    true for any ``Creator.objects...annotate(...)``. Do not reuse this under
    a ``.values('some_other_column').annotate(...)`` rollup, where the pk is
    not in the group key.
    """

    def get_group_by_cols(self):
        return []


def active_fans_count(now=None) -> Coalesce:
    """DB-side count of a Creator's currently-active subscribers.

    Annotate a ``Creator`` queryset with this instead of materialising the
    subscriber roster in Python: the profile endpoint only ever
    needed the number, and the list it used to build grew without any ceiling
    as a creator gained followers.

    Lives here rather than inline in a serializer so the *same* expression can
    back the server-side "at least N followers" filter on the Creators
    directory (issue, whose control used to filter on ``Creator.total``
    -- a cached ZEC page-support value, not a subscriber count).

        Creator.objects.annotate(fans_count=active_fans_count())
                       .filter(fans_count__gte=n)

    ``now`` is bound at expression-build time so every row in one queryset is
    counted against a single instant. ``expires__gte`` matches the boundary
    the old ``get_fans()``/serializer pair used, so the count is exactly the
    length of the list it replaces.

    A CORRELATED SUBQUERY, NOT A JOIN — and that is the whole point.
    ------------------------------------------------------------------
    This started life (in ) as ``Count('subscriptions_to_creator_set',
    distinct=True)``, which is *correct* but adds a second one-to-many LEFT
    JOIN to whatever queryset it lands in. The queryset it was built for --
    ``CreatorView._annotated_list_queryset``, the public ``/creators``
    directory -- already LEFT JOINs zPage for ``published_pages`` and
    ``last_page_activity``, so the two joins multiply: every creator
    contributes ``pages x fans`` rows to be aggregated away again.
    ``DISTINCT`` makes the *number* right and does nothing about the rows.

    Measured on the real directory query (300 creators, 1.8k pages, 2.2k
    subscriptions, a handful of them prolific-and-popular):

        without the annotation            5.3 ms
        Count(distinct=True) over a join  277 ms, 155k intermediate rows,
                                          19 MB spilled to disk per request
        this subquery                     9.9 ms, no fan-out, no spill

    That is a 52x regression on an endpoint rendered anonymously by the
    SvelteKit SSR pod on every visit to ``/creators``, and it gets worse as
    ``pages x fans`` rather than as either one -- i.e. worst exactly for the
    creators the directory most wants to show. The subquery form cannot fan
    out at all: it is one indexed lookup on ``g12f_subscription.star_id`` per
    creator row, the outer row count never changes, and no ``DISTINCT`` is
    needed because there is no join to duplicate anything.

    ``Coalesce(..., 0)`` because a correlated aggregate over an empty set
    returns NULL, and a creator with no fans has zero fans, not an unknown
    number of them -- ``fans_count__gte=0`` must match them and the serialized
    value must be an int.
    """
    if now is None:
        now = timezone.now()
    per_star = (
        Subscription.objects
        .filter(star=models.OuterRef('pk'), expires__gte=now)
        #.order_by() strips any default ordering, which would otherwise be
        # dragged into the GROUP BY and break the single-row guarantee.
        .order_by()
        .values('star')
        .annotate(n=models.Count('pk'))
        .values('n')
    )
    return _ActiveFansCount(
        models.Subquery(per_star, output_field=models.IntegerField()),
        models.Value(0),
        output_field=models.IntegerField(),
    )


class ActiveManager(models.Manager):
    def get_queryset(self):
        return super().get_queryset().filter(is_banned=False)


class BannedManager(models.Manager):
    def get_queryset(self):
        return super().get_queryset().filter(is_banned=True)


class Bannable(models.Model):
    is_banned = models.BooleanField(default=False)
    objects = ActiveManager()
    banned_objects = BannedManager()

    class Meta:
        abstract = True


# Issue. Columns that a plain, full ``Creator.save()`` must never write.
#
# ``tuzis`` is real user balance. Every deliberate mutation goes through
# ``dj.apps.tuzis.ledger``, which does the arithmetic in the database
# (``UPDATE creator SET tuzis = tuzis - x WHERE id = %s AND tuzis >= x``) so two
# concurrent spenders cannot both win — that was issue.
#
# But a full ``instance.save()`` writes EVERY column back from the in-memory
# instance, including a ``tuzis`` value that was read before the ledger moved
# it:
#
#     t0  request A loads creator (tuzis = 100)
#     t1  request B: ledger.debit(creator, 40)   -> DB is now 60
#     t2  request A: instance.save()             -> writes tuzis = 100
#
# 40 2Z created from nothing. ``CHECK (tuzis >= 0)`` cannot catch it: 100 is a
# perfectly legal value. The constraint guards overdraft; this is the opposite
# direction, and it is the one money bug the constraint is blind to.
#
# Auditing our own callers and sprinkling ``update_fields=[...]`` around is not
# a fix, because the loudest offenders are not ours to edit:
#
#   * ``rest_framework.serializers.ModelSerializer.update()`` — ``setattr`` the
#     validated fields, then a bare ``instance.save()``. This is the reported
#     path: PATCH /api/auth/user/ via ``CreatorProfileUpdateSerializer``.
#     ``tuzis`` being in ``read_only_fields`` does not help; that only stops the
#     client *setting* it, the stale value is written back regardless.
#   * ``django.contrib.auth.forms.SetPasswordForm.save()`` — bare
#     ``self.user.save()``. Reached by BOTH dj-rest-auth's password-change and
#     password-reset-confirm serializers.
#   * ``django.contrib.admin.ModelAdmin.save_model()`` — bare ``obj.save()`` on
#     an instance built from a form a human may have had open for minutes.
#     CreatorAdminForm now locks and checks its row version before this save;
#     the model-level balance exclusion remains the last line of defence.
#
# So the rule lives on the model instead: a full save writes every column
# except these, which makes the ledger the only writer *by construction* rather
# than by convention. A caller that genuinely means to set the column still
# can, explicitly and greppably, with ``save(update_fields=["tuzis"])``.
LEDGER_ONLY_FIELDS = frozenset({"tuzis"})

# Issue. Cached projections that a plain, full ``Creator.save()`` must
# not write from a potentially stale instance.
#
# This is deliberately NOT part of ``LEDGER_ONLY_FIELDS``. ``total`` is
# recomputed from authoritative zPage aggregates by ``cache_total()``; it is
# neither money nor ledger-owned, and no authorization or spend is gated on
# it. A clobber is therefore recoverable, unlike a clobbered ``tuzis`` balance.
#
# Recoverable does not mean harmless: ``total`` drives display and discovery
# ranking. ``score_pages`` repairs every creator on its 20-minute cycle, but a
# stale full save must not make the cache wrong until that repair. The full-save
# guard already has to enumerate excluded fields for the ledger invariant, so
# excluding this separate cache class adds no new save-path mechanism. Its real
# writer stays explicit and greppable: ``cache_total()`` calls
# ``save(update_fields=["total",...])``.
DERIVED_CACHE_FIELDS = frozenset({"total"})

# Issue. The key-transparency `account_epoch` counter, which a plain, full
# `Creator.save()` must not write.
#
# A third set rather than a member of either above, because it defends a third
# thing. `tuzis` is money and `total` is a cache; this is a **security counter**
# whose only correct direction is up, and the stale-write shape of / is
# fatal to it in a way it is not to the other two. The exact sequence:
# `dj.apps.emails` and `django.contrib.auth.forms.SetPasswordForm` change a
# password and increment the counter, and any bare `instance.save()` on an
# instance loaded earlier in the same request writes the pre-increment value
# straight back over it. The bump would be reverted by the very request that
# earned it, silently, leaving an assertion minted before the password change
# still spendable — which is the replay window the counter exists to close.
#
# Its only writer is `dj.apps.ktauth.epoch.bump_account_epoch`, which issues an
# `UPDATE... SET kt_account_epoch = kt_account_epoch + 1` and touches nothing
# else. See that module's docstring for what counts as an ownership event.
OWNERSHIP_COUNTER_FIELDS = frozenset({"kt_account_epoch"})

# Issue. Identifiers the database assigns once and nothing may change.
#
# `public_id` is the OIDC `sub` and the ledger's account key; a relying party
# that stored it must find the same account forever. A full save must not
# write it for a sharper reason than staleness: an instance built by hand
# (`Creator(pk=existing,...)`) holds a `DatabaseDefault` there, and Django
# renders that in an UPDATE as `SET public_id = DEFAULT` -- a brand-new UUID.
# An explicit `save(update_fields=["public_id"])` on an existing row raises
# (see `Creator.save`), and the database refuses every other path with the
# `g12f_creator_public_id_immutable` trigger (migration 0114).
IMMUTABLE_FIELDS = frozenset({"public_id"})

# Issue. A database trigger assigns this timestamp when persisted public
# profile content changes. A stale full Creator.save() (for example, a
# password change) must not write or erase the trigger-owned value.
PUBLIC_PROFILE_TIMESTAMP_FIELDS = frozenset({"public_profile_updated_at"})

#Everything a full save must leave alone, and everything it resyncs afterwards.
PROTECTED_FROM_FULL_SAVE = (
    LEDGER_ONLY_FIELDS
    | DERIVED_CACHE_FIELDS
    | OWNERSHIP_COUNTER_FIELDS
    | IMMUTABLE_FIELDS
    | PUBLIC_PROFILE_TIMESTAMP_FIELDS
)


class Creator(AbstractUser):
    """
    Shared user model between free2z and inner circle 0-0.
    """
    updated_at = models.DateTimeField(auto_now=True)
    # Scoped to edits of fields shown on the public creator profile. The
    # account-wide `updated_at` also moves for password/security changes, so
    # it must not back the public ProfilePage `dateModified` property.
    # NULL means there is no known public-profile edit since this field was
    # introduced; do not infer one from account creation or private activity.
    public_profile_updated_at = models.DateTimeField(
        null=True, blank=True, editable=False,
    )

    # TODO: overhaul?
    is_verified = models.BooleanField(
        default=False,
        help_text="Once a Creator is verified, all of their pages are",
    )
    # TODO: let's move everything to integers? 1 ZEC is worth 1000 2Z?
    # total is the cached amout of Zcash + (2Z/1000)
    # Sum of every owned page. A page itself permits almost 100 ZEC-equivalent,
    # so the old NUMERIC(10,8) creator cache could not represent two valid
    # high-value pages and made every repair fail at 99.99999999.
    total = models.DecimalField(default=0, max_digits=20, decimal_places=8)
    # TODO: could also have score...
    # score = models.DecimalField(default=0, max_digits=10, decimal_places=8)
    p2paddr = models.CharField(
        blank=True, max_length=255,
        validators=[validate_zcash_address],
    )
    # "zs12f4y80pjhy042rmxq339dr6885jqqvh9fc6j8pvxg3hyhc8hmsqurlkqtkzwp03quca27pt0f7k"
    # "u1fugcwe8xceuyvp7t8m3rpk22e0u8m3dyzdh9hdv40zsqpyvac7lxkx5t49nmp4p4w793ngh7fdc0zg7ws7w6gfdcx2rjthss0vhfdwrh"

    tuzis = models.DecimalField(
        # You get 0 for creating an account
        default=0, max_digits=17, decimal_places=3,
        help_text="Creator's usable 2Z credits",
        validators=[MinValueValidator(0)],
    )

    # TODO: remove
    # https://github.com/free2z/zuu/issues/33
    avatar_url = models.URLField(blank=True)
    banner_url = models.URLField(blank=True)
    ######
    avatar_image: GenericFile = models.ForeignKey(
        'uploads.GenericFile', null=True, blank=True,
        related_name="avatar_creators",
        on_delete=models.SET_NULL,
    )
    banner_image: GenericFile = models.ForeignKey(
        'uploads.GenericFile', null=True, blank=True,
        related_name="banner_creators",
        on_delete=models.SET_NULL,
    )

    full_name = models.CharField(max_length=128, blank=True)
    description = models.TextField(max_length=1024, blank=True)

    #2Z for 30 days of membership (members-only zPages, livestreams).
    #``0`` is a FREE membership -- a free follow that still grants member
    #access and moves no 2Z (``Subscription.extend`` skips the ledger).
    #Never NULL since: every creator offers a membership, and the
    #pre- NULL ("no membership offered") was backfilled to 0 by owner
    #decision (2026-10-06).
    member_price = models.DecimalField(
        max_digits=6, decimal_places=0,
        default=10,
        help_text=(
            "2Z for 30 days of membership, livestream access, etc. "
            "0 means a free membership (a free follow)."
        ),
        validators=[MinValueValidator(0)],
    )
    strikes = models.PositiveSmallIntegerField(default=0)

    password_set = models.BooleanField(default=True)

    # In-app @mention notifications are opt-in and are separate
    # from the legacy email notification preference.  The delivery path reads
    # this value as a suppression check. The publication path locks the
    # author for its own rolling-limit accounting, but that lock does not
    # serialize this recipient's independent preference update.
    mention_notifications_enabled = models.BooleanField(
        default=False, db_default=False,
    )

    #The durable per-account ownership counter the key-transparency authority
    #signs into a `HandleAssertion` (`KT.md` §4.5.4, issue ). It counts
    #**account-ownership events** — recovery and transfer — and never anything
    #derived from a clock; `dj.apps.ktauth.epoch` enumerates exactly which
    #events increment it and why that list is the security property.
    #
    #`editable=False` on purpose. It is not a value a human sets: an admin
    #form box for it would be a way to hand-write a security counter with no
    #audit trail, and `Creator.save()` excludes the column from full saves
    #anyway, so whatever was typed would be silently discarded. The only
    #writer is `bump_account_epoch()`.
    #
    #`PositiveIntegerField` rather than a bounded one: `KT.md` A18a's `2^20`
    #ceiling is checked when an assertion is *issued*, not when the counter is
    #incremented, because a database constraint at the ceiling would make an
    #account's millionth ownership event fail its **password reset** rather
    #than fail its key-transparency assertion. Refusing to issue is correct;
    #refusing to let someone recover their account is not.
    kt_account_epoch = models.PositiveIntegerField(
        default=1,
        editable=False,
        help_text=(
            "Key-transparency account-ownership counter. Incremented once per "
            "ownership event by dj.apps.ktauth.epoch; never set by hand."
        ),
    )

    #When the holder deleted this account themselves
    #(``dj.apps.g12f.account_deletion``). NULL for every live account and
    #for one merely deactivated by moderation. The username stays on the
    #deleted row -- the unique index reserves it against squatting -- until
    #``release_deleted_usernames`` frees it after
    #``account_deletion.USERNAME_RESERVATION``.
    deleted_at = models.DateTimeField(null=True, blank=True, editable=False)
    #Self-service deletion's 30-day grace period
    #(``dj.apps.g12f.account_deletion.schedule_deletion``): when the holder
    #asked, and when the purge may run. While ``purge_after`` is in the
    #future and ``deleted_at`` is unset, the account is inactive (hidden)
    #but its holder may sign in -- to an allowlist only -- and cancel.
    deletion_requested_at = models.DateTimeField(null=True, blank=True, editable=False)
    purge_after = models.DateTimeField(null=True, blank=True, editable=False)
    #When a sign-in last kept the account during a grace period. Shown in
    #settings, so an unwanted cancel is visible and can be re-requested.
    deletion_cancelled_at = models.DateTimeField(null=True, blank=True, editable=False)

    #When ``release_deleted_usernames`` freed that username. Explicit,
    #because a ``deleted_`` prefix is something anyone may register.
    username_released_at = models.DateTimeField(
        null=True, blank=True, editable=False)

    #free2z/zuu#1022. Set only on the LATER accounts of a group of usernames
    #that differ only by case and already existed when the database learned
    #to refuse them (migration 0110), to the username the account had then.
    #NULL everywhere else.
    #
    #``creator_username_ci_unique`` leaves a row out only while
    #``username == username_ci_legacy``. So the exemption covers exactly the
    #historical collision and nothing more: an exempt account that renames
    #re-enters the index under its new name, with no code path having to
    #remember to clear anything (codex adversarial review).
    #
    #Written once, by that migration; ``editable`` is off and nothing else
    #writes it. ``docs/e2ee/handles.md`` says how the exemptions are retired.
    username_ci_legacy = models.CharField(
        max_length=150,
        null=True,
        blank=True,
        editable=False,
        help_text=(
            "Legacy case-variant duplicate username this account held when "
            "case-insensitive uniqueness was enforced. Exempt from the index "
            "only while the username is unchanged. Set only by migration."
        ),
    )

    #Issue. The opaque, stable, per-account id: the OIDC ``sub`` and
    #what ``ledger.hold`` resolves to an account (docs/tuzis/ledger-v2.md
    #§4.1). Never the pk, which is enumerable and says how many accounts
    #exist.
    #
    #``db_default``, not a Python ``default``: the value comes from
    #``gen_random_uuid()`` in the database, so a row inserted by ANY writer
    #-- including the previous release, still serving while migration 0114's
    #rollout completes -- gets one. Django reads it back with ``RETURNING``
    #on insert, so ``Creator.objects.create(...).public_id`` is populated.
    #
    #Immutable: ``editable=False`` keeps it out of every form, a full save
    #never writes it (``IMMUTABLE_FIELDS``), naming it in ``update_fields``
    #raises, and a trigger refuses any UPDATE that would change it.
    public_id = models.UUIDField(
        db_default=RandomUUID(),
        editable=False,
        unique=True,
        help_text=(
            "Opaque, stable per-account id: the OIDC subject and the "
            "ledger's account key. Assigned by the database; never changes."
        ),
    )

    class Meta:
        verbose_name = "Creator"
        verbose_name_plural = "Creators"
        ordering = ["-total"]
        constraints = [
            # Issue. MinValueValidator(0) above is a *form/full_clean*
            # check and every money path saves with update_fields=[...] or
            #.update(), neither of which runs validators — so nothing
            # actually stopped a negative balance from being persisted.
            # This does, in the database, for every writer forever.
            models.CheckConstraint(
                condition=models.Q(tuzis__gte=0),
                name="creator_tuzis_non_negative",
                violation_error_message="2Z balance cannot go negative",
            ),
            # free2z/zuu#1022. Case-insensitive username uniqueness, in the
            # database. It used to exist only in serializers and the admin
            # form, which cannot stop two concurrent signups, and production
            # holds case-variant duplicates as a result. The pre-existing
            # duplicates (all but the earliest account in each group) are
            # excluded while they keep their legacy name; nothing new can join
            # them. Uses LOWER(), which is what messaging handles fold with.
            models.UniqueConstraint(
                Lower("username"),
                condition=(
                    models.Q(username_ci_legacy__isnull=True)
                    | ~models.Q(username_ci_legacy=models.F("username"))
                ),
                name="creator_username_ci_unique",
                violation_error_message=(
                    "A user with that username already exists!"
                ),
            ),
        ]

    # Model.save()'s positional parameters, in order. Positional arguments are
    # deprecated in Django 5.1 and removed in 6.0, but until then
    # ``save(False, False, None, ["tuzis"])`` is legal, so the override below
    # has to normalise them or the guard could be walked straight past.
    _SAVE_PARAM_NAMES = ("force_insert", "force_update", "using", "update_fields")

    def _full_save_update_fields(self):
        """Columns a full ``save()`` on this instance is allowed to write.

        Everything loaded, minus authoritative ``LEDGER_ONLY_FIELDS``,
        recomputable ``DERIVED_CACHE_FIELDS`` and monotonic
        ``OWNERSHIP_COUNTER_FIELDS``. The sets stay separate because they defend
        different invariants even though a stale full save is the mechanism that
        threatens all three. Returns ``None`` — "do not narrow, let
        Django behave normally" — only when there is no primary key, which is
        the one case that can ONLY be an INSERT. A new row has to write every
        column including defaults, and an INSERT cannot clobber anybody.

        Two things this deliberately does NOT treat as safe, both raised by the
        codex adversarial review:

        * ``self._state.adding``. It is True for every hand-constructed
          instance and does not imply an INSERT: with the pk set and no
          ``force_insert``, Django attempts an UPDATE first, and Creator's pk
          is a plain AutoField so none of the "pk has a default" insert
          shortcuts apply. ``Creator(pk=existing_id,...).save()`` — an
          ordinary shape for an import or repair script — would have written
          the FIELD DEFAULT of 0 over a live balance. Not stale money: no
          money.
        * ``using != self._state.db``. Django's own deferred-field narrowing
          bails out there, but its reason (don't write a partial row to a
          database that may not have it) is not ours. Mirroring it would
          switch the protection off in precisely the configuration that most
          needs it — an instance read from a replica and saved to primary,
          writing back the balance the replica had before the ledger moved it.
          There is one database today; there is no reason to leave that loaded
          for the day there are two.

        Deferred fields are excluded so ``.only()``/``.defer()`` instances do
        not trigger a fetch-per-column on save; attnames (not names) are used
        because that is what Django's own deferred-narrowing path passes and
        both are accepted by ``Model.save()``.
        """
        if self.pk is None:
            return None

        deferred = self.get_deferred_fields()
        excluded = PROTECTED_FROM_FULL_SAVE
        return frozenset(
            f.attname
            for f in self._meta.concrete_fields
            if not f.primary_key
            and not hasattr(f, "through")
            and f.attname not in deferred
            and f.name not in excluded
            and f.attname not in excluded
        )

    def save(self, *args, **kwargs):
        """A full save never writes protected ledger/cache columns. See /.

        Two deliberate consequences worth knowing about:

        * An empty result (the instance was loaded with ``.only("tuzis")``, so
          the balance is the ONLY thing a full save could write) makes Django
          skip the write entirely. Writing nothing is the safe answer there —
          writing something would be precisely the bug.
        * Once ``update_fields`` is set, a save aimed at a pk that has no row
          raises ``DatabaseError`` instead of silently falling back to an
          INSERT. That fallback is what resurrected concurrently-deleted
          accounts *with a stale balance*, so the loud failure is the better of
          the two. Code that means to insert a row with a chosen primary key
          says ``save(force_insert=True)``, which is honoured untouched.

        Skipping columns also means their in-memory values are now lies, so the
        instance is resynced from the row we just wrote. That is not cosmetic:
        ``CreatorProfileUpdateSerializer`` serializes both ``tuzis`` and
        ``total`` back to the client, and PATCH /api/auth/user/ is what the
        SvelteKit settings page loads into its auth store. Without the resync
        the database would be right while the response still displayed stale
        money/cache values. (codex review.)
        """
        if args:
            duplicated = set(self._SAVE_PARAM_NAMES[:len(args)]) & set(kwargs)
            if duplicated:
                raise TypeError(
                    "save() got multiple values for argument(s) "
                    + ", ".join(sorted(duplicated))
                )
            kwargs.update(zip(self._SAVE_PARAM_NAMES, args))

        explicit = kwargs.get("update_fields")
        if explicit is not None:
            # Django accepts any iterable; materialise it once so the check
            # below cannot exhaust a generator Django then sees empty (codex).
            explicit = kwargs["update_fields"] = frozenset(explicit)
        if explicit is not None:
            named = PUBLIC_PROFILE_TIMESTAMP_FIELDS.intersection(explicit)
            if named:
                raise ValueError(
                    f"Creator.{', '.join(sorted(named))} is maintained by "
                    "the database and cannot be assigned directly (#1108)"
                )

        if explicit is not None and self.pk is not None:
            named = IMMUTABLE_FIELDS.intersection(explicit)
            if named:
                raise ValueError(
                    f"Creator.{', '.join(sorted(named))} is assigned by the "
                    "database and never changes (#2215)"
                )

        narrowed = False
        if kwargs.get("update_fields") is None and not kwargs.get("force_insert"):
            update_fields = self._full_save_update_fields()
            if update_fields is not None:
                kwargs["update_fields"] = update_fields
                narrowed = True

        # Resolved BEFORE the save, the same way Django resolves it, because
        # `_state.db` is not reliable afterwards: an empty `update_fields`
        # (an instance loaded with `.only("tuzis")`) makes Django return early
        # without reaching `save_base`, so `_state.db` would still be whatever
        # the row was READ from. Passing `using=None` to `refresh_from_db` is
        # wrong for the same reason in reverse — it routes through
        # `db_for_read`. Under a future replica router either mistake resyncs
        # the balance FROM THE LAGGING REPLICA and hands the user exactly the
        # pre-debit number this resync exists to prevent. (codex review.)
        write_db = kwargs.get("using") or router.db_for_write(
            self.__class__, instance=self
        )

        result = super().save(**kwargs)

        if narrowed:
            # One extra SELECT of the protected columns, on a path that is a
            # profile edit or a password change — never a hot loop.
            self.refresh_from_db(
                fields=sorted(PROTECTED_FROM_FULL_SAVE),
                using=write_db,
            )
        return result

    def deletion_pending(self) -> bool:
        """Deletion requested and not yet purged -- including after
        ``purge_after``, until the purge actually runs (a blocked purge must
        not lock the holder out). Never true for an otherwise deactivated or
        already purged account. Whether a sign-in may KEEP it also depends on
        a ban since the request: ``account_deletion.keep_allowed``."""
        return bool(
            not self.is_active
            and self.deletion_requested_at is not None
            and self.purge_after is not None
            and self.deleted_at is None
        )

    def set_unusable_password(self):
        super().set_unusable_password()
        self.password_set = False

    def set_password(self, raw_password):
        super().set_password(raw_password)
        self.password_set = True

    def _get_session_auth_hash(self, secret=None):
        """Bind a session cookie to the account epoch, not just the password.

        Django's stock hash is an HMAC over the password, and
        ``django.contrib.auth.get_user`` recomputes it from the **freshly
        loaded row** on every request and flushes the session when it differs.
        That is already a use-time revocation channel; it just was not wired to
        this platform's ownership counter.

        Wiring it there closes the session half of  for free and with no
        table. ``bump_account_epoch`` deletes session rows, but a session
        *created* while the sweep was running — a login already past its
        credential check — is not in the sweep's enumeration and survives it.
        A session cookie carries the hash computed from the user instance the
        login held, so an event that commits afterwards makes the stored hash
        disagree with the row and the cookie stops authenticating. There is no
        window to race: the comparison happens when the cookie is presented.

        It also covers the six ownership events that do **not** touch the
        password, where the stock hash cannot change at all — a social unlink,
        an admin credential edit, a recovery-address change.

        **The value is byte-identical to Django's at the initial epoch, and
        that is deliberate, not an accident of implementation.** Every account
        starts at ``INITIAL_ACCOUNT_EPOCH`` and stays there until its first
        ownership event, so mixing the counter in unconditionally would change
        the hash for every account on the platform at once and sign every
        logged-in user out on deploy. Identity at epoch 1 leaves no hole: epoch
        1 means no ownership event has ever happened for this account, so there
        is nothing for the session to be stale with respect to.

        Overriding ``_get_session_auth_hash`` rather than
        ``get_session_auth_hash`` covers the ``SECRET_KEY_FALLBACKS`` path too
        — ``get_session_auth_fallback_hash`` calls this same method with each
        old secret, and an override that missed it would make a secret rotation
        log everyone out.
        """
        base = super()._get_session_auth_hash(secret=secret)
        epoch = self.kt_account_epoch or INITIAL_ACCOUNT_EPOCH
        if epoch == INITIAL_ACCOUNT_EPOCH:
            return base
        return salted_hmac(
            "dj.apps.g12f.models.creator.Creator.account_epoch_session_hash",
            f"{base}:{epoch}",
            secret=secret,
            algorithm="sha256",
        ).hexdigest()

    def get_thumbnail(self) -> str:
        p = "https://free2z.com"

        if self.avatar_image:
            return f"{p}{self.avatar_image.get_thumbnail()}"
        else:
            return f"{p}{default_logo_url()}"

    def get_avatar_url_safe(self) -> str:
        """
        don't forget to prepend the domain
        """
        if self.avatar_image:
            return self.avatar_image.get_url()
        else:
            return default_logo_url()

    def get_avatar_thumbnail_url_safe(self) -> str:
        """Return a small avatar rendition, or the same static fallback."""
        if self.avatar_image:
            return self.avatar_image.variant_url(128) or default_logo_url()
        return default_logo_url()

    def best_name(self) -> str:
        return self.full_name or self.username

    def html_description(self) -> str:
        return markdown2.markdown(self.description)

    def cache_total(self, *, nowait=False):
        from django.db.models import Sum
        from dj.apps.twitter.models import TwitterProfile

        write_db = router.db_for_write(
            self.__class__, instance=self
        )
        with transaction.atomic(using=write_db):
            # Serialize projection writers on the Creator row. A recompute is
            # derived rather than ledger-authoritative, but without the lock an
            # older aggregate can finish after a newer one and publish stale
            # display/ranking data indefinitely. Every source mutation that
            # calls cache_total() queues here; the last waiter recomputes from
            # the latest committed zPage rows instead of saving an old Python
            # value. _base_manager includes banned creators too.
            locked = (
                self.__class__._base_manager.using(write_db)
                .select_for_update(nowait=nowait)
                .get(pk=self.pk)
            )

            # One aggregate statement gives both components the same database
            # snapshot. Empty/all-NULL sets coalesce to zero so a creator with
            # no zPages does not fail here.
            aggregates = locked.zpage_set.using(write_db).aggregate(
                total=Sum('total'),
                tuzi_total=Sum('tuzi_total'),
            )
            total = aggregates['total'] or 0
            tuzi_total = aggregates['tuzi_total'] or 0
            locked.total = total + Decimal(tuzi_total) / Decimal(1000)

            # TODO: maybe a better approach to these elsewhere..
            try:
                if locked.twitter_profile:
                    locked.is_verified = True
            except TwitterProfile.DoesNotExist:
                pass
            locked.save(
                update_fields=['total', 'is_verified'], using=write_db
            )

        # Preserve the existing method contract: callers use this instance
        # immediately after recomputing and expect it to carry the stored cache.
        self.total = locked.total
        self.is_verified = locked.is_verified

    def has_fan(self, fan) -> bool:
        """
        Returns true if the argument is a current subscriber to the star
        """
        return Subscription.objects.filter(
            star=self,
            expires__gte=timezone.now(),
            fan=fan,
        ).exists()

    def has_star(self, star) -> bool:
        """
        Returns true if the argument is a current subscriber to the star
        """
        return Subscription.objects.filter(
            fan=self,
            expires__gte=timezone.now(),
            star=star,
        ).exists()

    def ban_and_soft_delete(self):
        # Get all fields that are FKs, OneToOne, M2Ms or reverse relations.
        for field in self._meta.get_fields():
            if isinstance(
                field,
                (
                    models.ForeignKey,
                    models.OneToOneField,
                    models.ManyToManyField,
                    models.ManyToOneRel,
                    models.OneToOneRel,
                ),
            ):
                # Get the related model.
                related_model = field.related_model

                # Check if the related model is Bannable.
                if issubclass(related_model, Bannable):
                    if isinstance(field, (models.ManyToOneRel, models.OneToOneRel)):
                        # For reverse relations, get the related objects using the related_name or default related_name
                        related_name = field.get_accessor_name()
                        related_objects = getattr(self, related_name).all()
                        # print("ban", related_objects)
                        related_objects.update(is_banned=True)

                    elif isinstance(field, models.OneToOneField):
                        related_object = getattr(self, field.name, None)
                        if related_object:
                            related_object.is_banned = True
                            # print("ban", related_object)
                            related_object.save()
                    else:
                        # Get the related objects and ban them all in one query.
                        related_objects = getattr(self, field.name).all()
                        # print("ban", related_objects)
                        related_objects.update(is_banned=True)

        # A pending self-deletion: record the ban, or a sign-in could keep
        # the account and lift it (is_active was already False). Under the
        # row lock "Keep my account" takes, in one transaction with the
        # deactivation: a keep then either lands first (the account is
        # active, no longer pending, and this is an ordinary ban) or after
        # (and finds the ban). An operator's shell has no request
        # transaction of its own, so this opens one.
        from dj.apps.g12f.account_deletion import note_ban

        with transaction.atomic():
            list(type(self).objects.select_for_update()
                 .filter(pk=self.pk).values_list('pk', flat=True))
            self.is_active = False
            # save to ban
            self.save(update_fields=['is_active', 'updated_at'])
            note_ban(self)

    # WHAT THIS DOES AND DOES NOT TAKE DOWN.
    #
    # `is_active=False` is now enforced by every zPage read path: the API
    # detail/list/related/variant routes, the series strip, both sitemaps, the
    # RSS feeds, comment threads, tag counts, the crawler cards, the
    # scheduled-publish and page-update tasks, the fund/vote money routes, and
    # the `/uploadz/public/...` auth subrequest. `zPage.objects
    #.published_and_active()` is the shared vocabulary; see that helper.
    #
    # Two things this does NOT do, both deliberate and both written down
    # rather than left to be rediscovered:
    #
    #   * It does not invalidate the CDN. `/uploadz/public/...` carries
    #     `s-maxage=3600` and `/uploadz/...` carries `max-age=86400`, and Cloud
    #     CDN serves a cached object without asking the origin. Deactivating
    #     stops NEW fetches; already-cached bytes need
    #     `bin/invalidate-hls-cdn.sh` (or `gcloud compute url-maps
    #     invalidate-cdn-cache`). Two steps, on purpose -- a moderation action
    #     must not be able to fail because a cloud API is having a bad minute.
    #   * The `is_banned` sweep above only reaches models that subclass
    #     `Bannable`, and `Comment` is currently the only one. The other
    #     creator-owned surfaces deliberately use `is_active` at their own
    #     public-read, money, notification and worker boundaries; they do not
    #     need a second per-model ban flag. Search rows are removed by the
    #     deactivation signal, and stale jobs still fail closed at execution.

    def get_fans(self) -> QuerySet:
        return Creator.objects.filter(
            subscriptions_owned_set__star=self,
            subscriptions_owned_set__expires__gte=timezone.now(),
        )

    def get_stars(self) -> QuerySet:
        return Creator.objects.filter(
            subscriptions_to_creator_set__fan=self,
            subscriptions_to_creator_set__expires__gte=timezone.now(),
        )

    def get_url(self) -> str:
        return f"/{self.username}"

    @property
    def can_stream(self) -> bool:
        """
        Returns True if the creator can start a livestream of the given type.
        """
        return self.tuzis >= 150


# One subscription billing period. Named because more than one place has to
# agree with it: `Subscription.extend()` moves `expires` by exactly this much,
# and `dj.apps.tuzis.views` derives the window of its renewal-affordability
# summary from it. A literal duplicated into either would silently make that
# summary claim to cover a period in which a subscription can be charged twice.
SUBSCRIPTION_PERIOD = timedelta(days=30)


# This is imported in a migration:/
def thirty_days():
    return timezone.now() + SUBSCRIPTION_PERIOD


# Issue: how long after a successful charge a repeat subscribe POST for
# the same (fan, star) is treated as a retry of that charge rather than a
# request for another month. Sized to cover the real failure: the SvelteKit
# client aborts at 15s, tells the user to reload, and the user re-clicks. A
# deliberate second month within a minute is not a thing anyone does; the user
# can simply click again a minute later.
SUBSCRIBE_DEBOUNCE = timedelta(seconds=60)


class Subscription(models.Model):
    """
    Gives fan the rights to a star's private content and livestreams
    """
    star: Creator = models.ForeignKey(
        'g12f.Creator', on_delete=models.CASCADE,
        related_name='subscriptions_to_creator_set',
    )
    fan: Creator = models.ForeignKey(
        'g12f.Creator', on_delete=models.CASCADE,
        related_name='subscriptions_owned_set',
    )
    # always add the amount of time you want after creating
    expires = models.DateTimeField(default=timezone.now)
    max_price = models.DecimalField(
        default=0, max_digits=7, decimal_places=0,
        help_text="Number of credits the sub is allowed to recur for",
        validators=[MinValueValidator(0)],
    )
    # Issue. Set every time extend() actually charges. A second POST
    # inside SUBSCRIBE_DEBOUNCE is treated as a retry of the first, not as a
    # request for a second month.
    last_charged_at = models.DateTimeField(
        null=True, blank=True,
        help_text="When this subscription was last charged (double-charge debounce)",
    )

    class Meta:
        unique_together = ('fan', 'star')

    def __str__(self) -> str:
        return f"{self.fan} subd {self.star}"

    def extend(
        self,
        debounce: timedelta = SUBSCRIBE_DEBOUNCE,
        expected_price=None,
        *,
        enforce_max_price=False,
    ) -> bool:
        """Charge the fan the star's member price and push expiry 30 days out.

        Returns True if the membership was extended (and, at a positive price,
        charged), False if this call was swallowed as a duplicate of a very
        recent one. At a price of 0 (a free membership, ) it extends
        without touching the ledger.

        Two things changed here (issues  / ):

        * The debit, the credit, the expiry bump and both Events are now ONE
          transaction over an atomic, non-negative-safe debit
          (``tuzis.ledger.transfer``). Before, the debit and the credit were
          two independent read-modify-write saves — a crash between them
          vaporised the fan's money, and two concurrent calls both read the
          same balance and both "succeeded".

        * The subscription row is locked for the duration and stamped with
          ``last_charged_at``. A duplicated/retried POST — the >15s-abort
          scenario in  — blocks on that lock, then sees a charge from
          moments ago and no-ops instead of billing a second month.

        ``expected_price`` binds an interactive confirmation to the debit. The
        creator rows are locked before comparing it, so a concurrent price
        update completes either before the comparison (and is rejected) or
        after this purchase commits; it cannot change the charged amount in
        between.

        ``enforce_max_price`` is for the automatic renewal caller. Legacy
        interactive subscribes may intentionally charge a current price above
        an old recurring cap (including zero after cancellation), but a
        renewal must never bypass that cap.

        Raises ``InsufficientFunds`` if the fan cannot cover the price, or
        ``ExpectedPriceMismatch`` when the locked current price differs from
        the confirmed price. Nothing is charged or extended in either case.
        """
        # I think the default get_user_model thing does like a
        # circular import or something
        from dj.apps.events.models import Event
        from dj.apps.tuzis import ledger

        price = None

        with transaction.atomic():
            from dj.apps.economy.epoch import pin_supported_policy
            pin_supported_policy()
            # Serialize concurrent extends of the SAME subscription. Any
            # duplicate waits here until the first has committed, so the
            # last_charged_at it then reads is authoritative.
            locked = (
                Subscription.objects.select_for_update()
                .filter(pk=self.pk)
                .values("last_charged_at", "expires", "max_price")
                .first()
            )
            if locked is None:
                # Row vanished (unsubscribed concurrently). Nothing to extend.
                return False

            now = timezone.now()
            last = locked["last_charged_at"]
            if not Creator.objects.filter(
                pk=self.star_id, is_active=True
            ).exists():
                raise ledger.InactiveCreator(self.star)
            if last is not None and now - last < debounce:
                # A distinct confirmed intent still has to satisfy its price
                # contract even though it cannot charge inside the debounce
                # window. This ordinary MVCC read takes no Creator row lock;
                # the charged path below revalidates under the balance locks.
                if expected_price is not None:
                    current_price = Creator.objects.values_list(
                        "member_price", flat=True
                    ).get(pk=self.star_id)
                    if current_price != expected_price:
                        raise ledger.ExpectedPriceMismatch(
                            expected_price, current_price
                        )
                # The subscription lock alone makes this duplicate decision
                # authoritative. Return before touching either shared Creator
                # row: this path cannot move money, and letting free retries
                # queue behind a popular creator's balance lock would amplify
                # abusive or runaway clients into a money-path lock convoy.
                # Refresh in-memory state so the caller reports the truth. In
                # particular, an explicit one-time purchase must not re-enable
                # renewal on a row the fan already cancelled.
                self.refresh_from_db()
                return False

            # Every subscription extension locks its subscription first, then
            # both balance rows in the same global pk order used by donations.
            # Holding the creator row lock through comparison + transfer makes
            # the expected-price check part of the money transaction.
            ledger.lock_in_order(self.fan, self.star)
            locked_star = Creator.objects.get(pk=self.star_id)
            if not locked_star.is_active:
                raise ledger.InactiveCreator(locked_star)
            # The charge must use the price from the same locked row that was
            # validated. In particular, a stale legacy `self.star` instance
            # must never undercharge after the creator updates their price.
            price = locked_star.member_price
            if expected_price is not None:
                if price != expected_price:
                    raise ledger.ExpectedPriceMismatch(expected_price, price)
            if enforce_max_price and (
                price is None or price > locked["max_price"]
            ):
                raise ledger.ExpectedPriceMismatch(locked["max_price"], price)
            if price is None or price < 0:
                raise ledger.ExpectedPriceMismatch(expected_price, price)

            # A free membership  extends exactly like a paid one --
            # same locks, same debounce stamp, same Events -- but moves no
            # 2Z: there is no zero-amount ledger row (``transfer`` refuses a
            # non-positive amount by design). The active-creator check the
            # ledger would have made is the ``locked_star.is_active`` gate
            # above.
            # Membership payments remain restricted utility sharing.
            if price > 0:
                ledger.transfer(self.fan, self.star, price, action="subscription")

            if price > 0:
                # A paid month stacks: buying early never wastes what the
                # fan already paid for.
                self.expires = max([
                    locked["expires"] + SUBSCRIPTION_PERIOD,
                    now + SUBSCRIPTION_PERIOD,
                ])
            else:
                # A free month does NOT stack (codex review): with no
                # cost per request, stacking would let a fan bank years of
                # access with fresh keys while the price is 0 and keep it
                # after the creator starts charging. Free tops access up to
                # 30 days from now, never beyond.
                self.expires = max([
                    locked["expires"],
                    now + SUBSCRIPTION_PERIOD,
                ])
            self.last_charged_at = now
            # Keep the recurring ceiling completely separate from this
            # immediate-purchase consent. A new row already has the requested
            # price as its default; an existing row retains its prior ceiling,
            # including zero after cancellation. Synchronize the instance so
            # the post_save renewal scheduler sees the locked value, while the
            # partial save cannot overwrite a concurrent cancellation.
            self.max_price = locked["max_price"]
            # extending the subscription should not bump the creators'
            # timestamps; the ledger no longer touches them at all.
            self.save(update_fields=["expires", "last_charged_at"])
            Event.objects.create(
                read=False,
                type="SUBSCRIPTION_RECEIVED",
                receiving_user=self.star,
                payee=self.star,
                contributor=self.fan,
                amount=price,
                content_type=ContentType.objects.get_for_model(self.fan),
                object_id=self.fan.pk,
            )
            Event.objects.create(
                read=False,
                type="SUBSCRIPTION_SENT",
                receiving_user=self.fan,
                payee=self.star,
                contributor=self.fan,
                amount=price,
                content_type=ContentType.objects.get_for_model(self.star),
                object_id=self.star.pk,
            )

        return True
