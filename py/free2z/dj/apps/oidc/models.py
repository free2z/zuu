"""The provider's tables: the registration, the grant, and the swapped tokens.

Every django-oauth-toolkit model is swapped here (``OAUTH2_PROVIDER_*_MODEL``
in settings), so the library's own migrations create nothing and the whole
provider is ``oidc_*``. The only foreign keys leave the app for
``settings.AUTH_USER_MODEL``.

Two of these tables are the platform's, not the library's:

*class:`F2ZApplication` -- the registration (spec §2). Its primary key is a
  UUID because the ledger's ``ledger_app`` projection and ``ledger_hold.app_
  id`` are that id (docs/tuzis/ledger-v2.md §3.6), and because a sequential
  id would count how many apps exist.
*class:`AppAuthorization` -- the grant (spec §5): one per (user, app),
  carrying the consented scopes, the spend cap, the consented markup, and the
  generation that every token stamps as ``agen``.

The stamps on the token rows are what make revocation a use-time comparison
rather than a sweep, the same doctrine as ``dj.apps.ktauth.credentials``: an
access token records the account epoch and the grant generation it was minted
under, a refresh token records the epoch, and the thing that validates each
compares the stamp with the row's current value.

Mixed-fleet safety
------------------
The migration creates seven new tables and nothing else. Pods on the previous
release have no model for any of them, so the rollout window has nothing to
disagree about, and a code rollback leaves unused tables behind rather than a
broken schema.
"""
from __future__ import annotations

import uuid

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.db.models import F, Q
from django.utils import timezone
from oauth2_provider.models import (
    AbstractAccessToken,
    AbstractApplication,
    AbstractDeviceGrant,
    AbstractGrant,
    AbstractIDToken,
    AbstractRefreshToken,
    ClientSecretField,
)

from . import redirects
from .scopes import ALL_SCOPES, MARKUP_CAP_BPS, scope_list, scope_string


class CapPeriod(models.TextChoices):
    """Spec §5: calendar-aligned in UTC; ``total`` never resets."""

    DAY = "day", "per day"
    WEEK = "week", "per week"
    MONTH = "month", "per month"
    TOTAL = "total", "in total"


#The order a period's "size" ranks in for the raise/lower rule of spec §5
#(``total`` counts as the longest).
CAP_PERIOD_RANK = {
    CapPeriod.DAY: 1,
    CapPeriod.WEEK: 2,
    CapPeriod.MONTH: 3,
    CapPeriod.TOTAL: 4,
}


class MarkupApproval(models.TextChoices):
    NONE = "none", "no markup"
    PENDING = "pending", "awaiting approval"
    APPROVED = "approved", "approved"


class OptionalClientSecretField(ClientSecretField):
    """The library's hashed secret column, except that EMPTY stays empty.

    The library hashes whatever the column holds on save, including ``""``
    -- and a public client, which is issued no secret (spec §2), would then
    carry a valid password hash of the empty string. Together with
    ``constant_time_compare`` on a stored value that fails
    ``identify_hasher`` that is one misconfiguration away from "any secret
    works". Empty means "no secret", and the validator refuses to compare
    against it (``F2ZOAuth2Validator._check_secret``).
    """

    def pre_save(self, model_instance, add):
        if not getattr(model_instance, self.attname):
            return ""
        return super().pre_save(model_instance, add)


class F2ZApplication(AbstractApplication):
    """A registered app (spec §2).

    ``user`` -- django-oauth-toolkit's owner column -- IS the developer
    account, exposed as:attr:`developer`. One column, one meaning; the
    ledger's ``ledger_app.developer_creator_id`` is a projection of it.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    # Overrides of the library's fields (Django allows overriding a field
    # inherited from an abstract base).
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        related_name="developed_apps",
        null=True,
        blank=True,
        # A developer account with registered apps is not deletable by
        # accident; the markup credited to it is a ledger fact.
        on_delete=models.PROTECT,
        verbose_name="developer",
        help_text="The developer account: where markup is credited as 2Z.",
    )
    authorization_grant_type = models.CharField(
        max_length=44,
        choices=AbstractApplication.GRANT_TYPES,
        default=AbstractApplication.GRANT_AUTHORIZATION_CODE,
        editable=False,
    )
    # ID tokens are RS256 (spec §7), for every app; the key is the ring's,
    # not a per-app setting. See `jwk_key`.
    algorithm = models.CharField(
        max_length=5,
        choices=AbstractApplication.ALGORITHM_TYPES,
        default=AbstractApplication.RS256_ALGORITHM,
        editable=False,
    )
    # No default: a public client is issued no secret (spec §2) and `save`
    # blanks it; a confidential client gets one from `issue_client_secret`.
    client_secret = OptionalClientSecretField(
        max_length=255, blank=True, default="", db_index=True,
    )

    first_party = models.BooleanField(
        default=False,
        help_text="Free2Z's own app. Same PKCE flow as everyone else; the "
                  "flag only selects first-party features such as IAP rails.",
    )
    markup_bps = models.PositiveIntegerField(
        default=0,
        help_text="The developer markup the app ASKS for, in basis points "
                  f"(0..{MARKUP_CAP_BPS}). Applied only up to approved_markup_bps.",
    )
    approved_markup_bps = models.PositiveIntegerField(
        null=True,
        blank=True,
        help_text="Set by an operator, by hand. NULL = never reviewed; 0 = "
                  "refused. Effective markup = min(markup_bps, approved).",
    )
    allowed_scopes = models.TextField(
        blank=True,
        help_text="Space-separated subset of the platform scopes the app may request.",
    )
    allow_zcash_assertion = models.BooleanField(
        default=False,
        help_text="May use the Zcash sign-in grant once it exists (spec §9.4).",
    )
    default_spend_cap_2z = models.PositiveIntegerField(
        null=True, blank=True,
        help_text="Pre-selected cap on a first consent when ai:invoke is requested.",
    )
    default_cap_period = models.CharField(
        max_length=8, choices=CapPeriod.choices, default=CapPeriod.MONTH,
    )
    logo_url = models.URLField(blank=True, max_length=1024)
    privacy_url = models.URLField(blank=True, max_length=1024)
    terms_url = models.URLField(blank=True, max_length=1024)
    frozen = models.BooleanField(
        default=False,
        help_text="A frozen app cannot authorize or mint tokens; existing "
                  "access tokens are refused at use.",
    )
    # db_default too: during a rollout an old pod inserts a registration
    # without this column, and a Python-only default would fail it.
    child_directed = models.BooleanField(
        default=False,
        db_default=False,
        help_text="The app is directed to children or to all ages. The "
                  "consent screen addresses the adult account holder, and "
                  "access tokens carry `child_directed` for the AI gateway. "
                  "A developer may set it; only staff may unset it. Every "
                  "change is recorded in AudienceChange.",
    )

    class Meta(AbstractApplication.Meta):
        swappable = "OAUTH2_PROVIDER_APPLICATION_MODEL"
        verbose_name = "registered app"
        constraints = [
            models.CheckConstraint(
                condition=Q(markup_bps__lte=MARKUP_CAP_BPS),
                name="oidc_application_markup_within_cap",
            ),
            models.CheckConstraint(
                condition=Q(approved_markup_bps__isnull=True)
                | Q(approved_markup_bps__lte=MARKUP_CAP_BPS),
                name="oidc_application_approved_markup_within_cap",
            ),
            models.CheckConstraint(
                condition=Q(client_type__in=["public", "confidential"]),
                name="oidc_application_client_type_known",
            ),
        ]

    # ------------------------------------------------------------ identity
    @property
    def developer(self):
        return self.user

    @property
    def developer_id(self):
        return self.user_id

    # ------------------------------------------------------------- markup
    @property
    def effective_markup_bps(self) -> int:
        """``min(markup_bps, approved_markup_bps or 0)`` (spec §2)."""
        return min(self.markup_bps, self.approved_markup_bps or 0)

    @property
    def markup_approval(self) -> str:
        if self.markup_bps == 0:
            return MarkupApproval.NONE
        if self.markup_bps > (self.approved_markup_bps or 0):
            return MarkupApproval.PENDING
        return MarkupApproval.APPROVED

    # ------------------------------------------------------------- scopes
    @property
    def allowed_scope_list(self) -> list[str]:
        return scope_list(self.allowed_scopes)

    # ---------------------------------------------------------- redirects
    @property
    def redirect_uri_list(self) -> list[str]:
        return self.redirect_uris.split()

    def get_allowed_schemes(self):
        """``https``, loopback ``http``, plus every registered private scheme.

        django-oauth-toolkit checks the scheme of a redirect target against
        this list; a reverse-DNS scheme is only ever allowed for the app that
        registered it.
        """
        schemes = {"https", "http"}
        for uri in self.redirect_uri_list:
            scheme = redirects.private_scheme_of(uri)
            if scheme:
                schemes.add(scheme)
        return sorted(schemes)

    # ------------------------------------------------------------ signing
    @property
    def jwk_key(self):
        """The ring's active RS256 key (spec §7), for every app.

        Overrides the library's per-setting PEM: keys are owner-provisioned
        through the environment and rotated with `oidc_rotate_keys`.
        """
        from .keys import get_keyring

        return get_keyring().active_rs256.jwk

    def is_usable(self, request):
        return not self.frozen

    def issue_client_secret(self) -> str:
        """Mint a secret for a confidential client; returns the plaintext once.

        Stored hashed by the library's ``ClientSecretField``.
        """
        from oauth2_provider.generators import generate_client_secret

        if self.client_type != self.CLIENT_CONFIDENTIAL:
            raise ValueError("only a confidential client is issued a secret")
        secret = generate_client_secret()
        self.client_secret = secret
        return secret

    # --------------------------------------------------------- validation
    def clean(self) -> None:
        """The registration invariants (spec §2, §3).

        Deliberately NOT ``super().clean()``: the library's version requires
        its own ``OIDC_RSA_PRIVATE_KEY`` setting for RS256 and validates
        redirect URIs more loosely than §3. Everything it would have caught
        for this app's shapes is caught here.
        """
        errors: dict[str, list[str]] = {}

        uris = self.redirect_uri_list
        if not uris:
            errors.setdefault("redirect_uris", []).append(
                "at least one redirect URI is required"
            )
        for uri in uris:
            try:
                kind = redirects.classify(uri)
            except redirects.RedirectURIError as exc:
                errors.setdefault("redirect_uris", []).append(f"{uri}: {exc}")
                continue
            if (
                self.client_type == self.CLIENT_CONFIDENTIAL
                and kind != redirects.KIND_HTTPS
            ):
                errors.setdefault("redirect_uris", []).append(
                    f"{uri}: a confidential client may only register https "
                    "redirect URIs (spec §3)"
                )
        if len(set(uris)) != len(uris):
            errors.setdefault("redirect_uris", []).append("duplicate redirect URI")

        unknown = [s for s in self.allowed_scope_list if s not in ALL_SCOPES]
        if unknown:
            errors.setdefault("allowed_scopes", []).append(
                f"unknown scope(s): {' '.join(unknown)}"
            )
        self.allowed_scopes = scope_string(self.allowed_scope_list)

        if self.markup_bps > MARKUP_CAP_BPS:
            errors.setdefault("markup_bps", []).append(
                f"the platform cap is {MARKUP_CAP_BPS} bps"
            )
        if self.approved_markup_bps is not None and self.approved_markup_bps > MARKUP_CAP_BPS:
            errors.setdefault("approved_markup_bps", []).append(
                f"the platform cap is {MARKUP_CAP_BPS} bps"
            )
        if self.client_type == self.CLIENT_PUBLIC and self.client_secret:
            # A public client is issued no secret (spec §2). Blank rather
            # than error: the library's field default would otherwise mint
            # one silently on every public registration.
            self.client_secret = ""
        if self.client_type == self.CLIENT_CONFIDENTIAL and not self.client_secret:
            errors.setdefault("client_secret", []).append(
                "a confidential client needs a secret: call issue_client_secret()"
            )
        for origin in self.allowed_origins.split():
            if not origin.startswith("https://") or origin.rstrip("/") != origin:
                errors.setdefault("allowed_origins", []).append(
                    f"{origin}: an allowed origin is an https origin with no path"
                )
        self._clean_registration_policy(errors)
        if errors:
            raise ValidationError(errors)

    #The fields 's registration policy judges, and the value each had
    #when the row was loaded (``from_db``). The policy judges a field only
    #when it is new or has CHANGED: a row that predates the policy must
    #stay saveable by an operator -- freezing a lookalike app in the admin
    #must not first demand that someone rename it. Such rows are still
    #fenced at use: ``cors`` refuses a same-site origin per request and the
    #consent page shows only https metadata links.
    POLICY_FIELDS = ("name", "allowed_origins", "logo_url", "privacy_url", "terms_url")

    @classmethod
    def from_db(cls, db, field_names, values):
        instance = super().from_db(db, field_names, values)
        instance._policy_loaded = {
            name: getattr(instance, name)
            for name in cls.POLICY_FIELDS
            if name in instance.__dict__
        }
        return instance

    def _policy_judges(self, field: str) -> bool:
        loaded = getattr(self, "_policy_loaded", None)
        if self._state.adding or loaded is None or field not in loaded:
            return True
        return loaded[field] != getattr(self, field)

    def _clean_registration_policy(self, errors: dict[str, list[str]]) -> None:
        """Spec §2 +: see:mod:`.registration_policy`."""
        from . import registration_policy as policy

        if self._policy_judges("name"):
            problem = policy.name_problem(self.name or "", first_party=self.first_party)
            if problem:
                errors.setdefault("name", []).append(problem)
        if self._policy_judges("allowed_origins"):
            for origin in self.allowed_origins.split():
                problem = policy.origin_problem(origin)
                if problem:
                    errors.setdefault("allowed_origins", []).append(f"{origin}: {problem}")
        for field in ("logo_url", "privacy_url", "terms_url"):
            if self._policy_judges(field):
                problem = policy.https_url_problem(getattr(self, field) or "")
                if problem:
                    errors.setdefault(field, []).append(problem)

    def save(self, *args, **kwargs):
        # The invariants above hold for every writer, not only the admin
        # form: the console and tests create rows programmatically.
        self.clean()
        super().save(*args, **kwargs)
        # What was just written is what the next save compares against.
        self._policy_loaded = {name: getattr(self, name) for name in self.POLICY_FIELDS}

    def __str__(self) -> str:
        return self.name or self.client_id


class AuthorizationCode(AbstractGrant):
    """A single-use authorization code (60 s), plus the authentication
    context of the session that consented, carried into the tokens.

    ``account_epoch`` is the epoch the consenting session was validated
    against. A code minted before an ownership event (a password reset in
    the code's 60-second window, from a compromised session) must not be
    redeemable after it: ``validate_code`` compares this stamp with the row.
    """

    account_epoch = models.PositiveIntegerField()
    auth_time = models.DateTimeField(null=True, blank=True)
    acr = models.CharField(max_length=64, blank=True)
    amr = models.JSONField(default=list, blank=True)
    #RFC 6749 §4.1.2: a code presented twice is an attack signal, and the
    #tokens issued on its FIRST redemption must be revoked. The library
    #deletes the row on redemption, which loses that evidence; this app
    #keeps it, marked, until the sweep removes expired codes.
    redeemed_at = models.DateTimeField(null=True, blank=True)
    redeemed_family = models.UUIDField(null=True, blank=True, editable=False)
    redeemed_access_token = models.OneToOneField(
        "oidc.AccessToken", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="source_authorization_code", editable=False,
    )

    class Meta(AbstractGrant.Meta):
        swappable = "OAUTH2_PROVIDER_GRANT_MODEL"


class AccessToken(AbstractAccessToken):
    """The row behind an ES256 JWT.

    The JWT is self-contained for resource servers; this row is what lets the
    IdP's own API (``OAuth2JWTAuthentication``) and the introspection
    endpoint refuse a token whose family was revoked before it expired, and
    what the stamps below are compared against.
    """

    account_epoch = models.PositiveIntegerField()
    grant_generation = models.PositiveIntegerField()
    auth_time = models.DateTimeField(null=True, blank=True)
    acr = models.CharField(max_length=64, blank=True)
    amr = models.JSONField(default=list, blank=True)

    class Meta(AbstractAccessToken.Meta):
        swappable = "OAUTH2_PROVIDER_ACCESS_TOKEN_MODEL"
        constraints = [
            models.CheckConstraint(
                condition=Q(account_epoch__gte=1) & Q(grant_generation__gte=1),
                name="oidc_accesstoken_stamps_positive",
            ),
        ]


class RefreshToken(AbstractRefreshToken):
    """An opaque, rotating refresh token in a family (spec §8).

    ``token_family`` and ``revoked`` are the library's; ``account_epoch`` is
    the stamp that makes a stale epoch refuse the refresh (spec §6.2).
    """

    account_epoch = models.PositiveIntegerField()

    class Meta(AbstractRefreshToken.Meta):
        swappable = "OAUTH2_PROVIDER_REFRESH_TOKEN_MODEL"


class IDToken(AbstractIDToken):
    class Meta(AbstractIDToken.Meta):
        swappable = "OAUTH2_PROVIDER_ID_TOKEN_MODEL"


class DeviceGrant(AbstractDeviceGrant):
    """Swapped so the library creates no table of its own. The device
    authorization grant is not offered (spec §1, "Not in v1")."""

    class Meta(AbstractDeviceGrant.Meta):
        swappable = "OAUTH2_PROVIDER_DEVICE_GRANT_MODEL"


class AudienceChange(models.Model):
    """Append-only audit of ``F2ZApplication.child_directed``: who changed
    it, when, to what, and through which surface. A developer may set it in
    the console; only staff may unset it, in the admin."""

    class Via(models.TextChoices):
        CONSOLE = "console", "Developer console"
        ADMIN = "admin", "Admin"

    id = models.BigAutoField(primary_key=True)
    application = models.ForeignKey(
        F2ZApplication, on_delete=models.CASCADE, related_name="audience_changes",
    )
    previous = models.BooleanField(
        null=True, help_text="The value before the change; null for a new registration.",
    )
    child_directed = models.BooleanField(help_text="The value after the change.")
    changed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL,
        related_name="+",
    )
    via = models.CharField(max_length=8, choices=Via.choices)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = "audience change"
        indexes = [models.Index(fields=["application", "-created_at"],
                                name="oidc_audience_app_created")]

    @classmethod
    def record(cls, application, *, previous, by, via) -> "AudienceChange":
        return cls.objects.create(application=application, previous=previous,
                                  child_directed=application.child_directed,
                                  changed_by=by, via=via)


class AppAuthorizationQuerySet(models.QuerySet):
    def live(self):
        return self.filter(revoked_at__isnull=True)


class AppAuthorization(models.Model):
    """The grant: (user, app, scopes, cap, consented markup, generation).

    One per (user, app). Re-consent replaces scopes, cap and markup in place
    (spec §5) and never resets spending history, which lives in the ledger.
    ``generation`` is ``agen``: it moves when the grant is revoked, when its
    scopes are reduced, and when a refresh-token family detects reuse.
    """

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="app_authorizations",
    )
    application = models.ForeignKey(
        F2ZApplication,
        on_delete=models.CASCADE,
        related_name="authorizations",
    )
    scope = models.TextField(blank=True)
    spend_cap_2z = models.PositiveIntegerField(
        null=True, blank=True, help_text="Whole 2Z; NULL = no cap.",
    )
    cap_period = models.CharField(
        max_length=8, choices=CapPeriod.choices, default=CapPeriod.MONTH,
    )
    #The app's EFFECTIVE markup at consent (spec §5): the ceiling on what
    #the ledger prices this user's calls with.
    markup_bps = models.PositiveIntegerField(default=0)
    generation = models.PositiveIntegerField(default=1)
    revoked_at = models.DateTimeField(null=True, blank=True)
    consented_at = models.DateTimeField(default=timezone.now)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    objects = AppAuthorizationQuerySet.as_manager()

    class Meta:
        verbose_name = "app authorization"
        constraints = [
            models.UniqueConstraint(
                fields=["user", "application"],
                name="oidc_appauthorization_user_application_unique",
            ),
            models.CheckConstraint(
                condition=Q(generation__gte=1),
                name="oidc_appauthorization_generation_positive",
            ),
            models.CheckConstraint(
                condition=Q(markup_bps__lte=MARKUP_CAP_BPS),
                name="oidc_appauthorization_markup_within_cap",
            ),
            models.CheckConstraint(
                condition=Q(cap_period__in=["day", "week", "month", "total"]),
                name="oidc_appauthorization_cap_period_known",
            ),
        ]

    def __str__(self) -> str:
        return f"grant {self.user_id} -> {self.application_id} (gen {self.generation})"

    @property
    def scope_list(self) -> list[str]:
        return scope_list(self.scope)

    @property
    def is_live(self) -> bool:
        return self.revoked_at is None

    def bump_generation(self) -> int:
        """``generation += 1`` in the database, returning the new value.

        ``F()`` so two concurrent bumps are two increments; the row is
        re-read so the caller publishes the value that was written.
        """
        type(self)._default_manager.filter(pk=self.pk).update(
            generation=F("generation") + 1, updated_at=timezone.now(),
        )
        self.refresh_from_db(fields=["generation", "updated_at"])
        return self.generation


class AiOutputReport(models.Model):
    """A user's in-app report of one AI call's output (store AI-content policy).

    Google Play's AI-Generated Content policy and Apple guideline 4.7 require
    an app to let a user flag AI output without leaving the app, and the flag
    has to reach somebody who can act. SDK apps have no backend of their own,
    so Free2Z keeps the queue: ``POST /api/sdk/v1/calls/{call_id}/report``
    writes here, the app's developer reads its own app's rows in the
    developer console, and Free2Z moderation works them in the admin.

    Minimal by design, because the apps may be used by children:

    * **No AI content.** The gateway keeps no prompt or output, and this row
      does not either: only the call's id and the resolved model id, read
      from the call's non-content metadata when the report is filed.
    * **A reason enum** and an optional ``detail`` of at most 200 characters
      (one line). Apps that children may use are told to offer presets.
    * ``call_id`` is NOT a foreign key. ``ledger_gateway_call`` rows are
      deleted after 90 days (``ledger.cleanup_gateway_calls``) and a report
      must outlive that.

    One row per (reporter, call): a repeat replaces the reason and detail.
    """

    class Reason(models.TextChoices):
        INCORRECT = "incorrect", "Incorrect"
        INAPPROPRIATE = "inappropriate", "Inappropriate"
        UNSAFE = "unsafe", "Unsafe"
        OTHER = "other", "Other"

    class Status(models.TextChoices):
        OPEN = "open", "Open"
        REVIEWING = "reviewing", "Reviewing"
        RESOLVED = "resolved", "Resolved"

    DETAIL_MAX_LENGTH = 200

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    # PROTECT: an app with reports has grants, and an app with grants cannot
    # be deleted (DeveloperAppDetailView.delete) -- this only makes that
    # explicit for the moderation record.
    application = models.ForeignKey(
        F2ZApplication, on_delete=models.PROTECT, related_name="ai_output_reports",
    )
    # SET_NULL: account deletion removes who reported, not that it was reported.
    reporter = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL,
        related_name="ai_output_reports",
    )
    call_id = models.UUIDField()
    model = models.CharField(max_length=128, blank=True, default="")
    reason = models.CharField(max_length=16, choices=Reason.choices)
    detail = models.CharField(max_length=DETAIL_MAX_LENGTH, blank=True, default="")
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.OPEN)
    staff_notes = models.TextField(blank=True, default="")
    #When the report first became ``unsafe`` (filed so, or escalated). Set
    #once: the unsafe alert fires once per report, and the hourly cap counts it.
    unsafe_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "AI output report"
        constraints = [
            models.UniqueConstraint(
                fields=["reporter", "call_id"],
                name="oidc_aioutputreport_reporter_call_unique",
            ),
            models.CheckConstraint(
                condition=Q(reason__in=["incorrect", "inappropriate", "unsafe", "other"]),
                name="oidc_aioutputreport_reason_known",
            ),
        ]
        indexes = [
            models.Index(fields=["application", "-created_at"], name="oidc_aireport_app_created"),
            models.Index(fields=["reporter", "created_at"], name="oidc_aireport_reporter_created"),
            models.Index(fields=["status", "reason", "created_at"], name="oidc_aireport_queue"),
            # The surge count and its 5-minute sweep: unsafe reports by app in
            # the trailing hour. Partial, so it holds only unsafe rows.
            models.Index(fields=["application", "unsafe_at"], name="oidc_aireport_app_unsafe",
                         condition=Q(reason="unsafe")),
        ]

    def __str__(self) -> str:
        return f"AI report {self.pk} ({self.reason}) on call {self.call_id}"
