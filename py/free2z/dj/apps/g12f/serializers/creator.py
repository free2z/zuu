import os

from django.conf import settings
from django.utils.translation import gettext_lazy as _
from django.utils import timezone
from django.contrib.auth import password_validation
from django.contrib.auth.forms import SetPasswordForm
from django.contrib.auth.hashers import check_password
from django.core.exceptions import ValidationError
from django.contrib.auth import get_user_model
from django.db import transaction

from rest_framework import serializers
from rest_framework.exceptions import APIException, Throttled
from dj_rest_auth.serializers import (
    LoginSerializer,
    PasswordChangeSerializer,
    UserDetailsSerializer,
)
from drf_spectacular.utils import extend_schema_field
from drf_spectacular.extensions import OpenApiSerializerExtension

from dj.apps.identity.auth_context import require_recent_auth
from dj.apps.g12f.captcha import (
    CAPTCHA_UNAVAILABLE_MESSAGE,
    CaptchaUnavailable,
    siteverify,
    verify_captcha_response,
)
from dj.apps.g12f.models import Creator, zPage, Subscription
from dj.apps.g12f.usernames import is_forbidden_username
from dj.apps.emails.models import PasswordResetToken
from dj.apps.ktauth.epoch import EVENT_PASSWORD_CHANGE, bump_account_epoch
from dj.apps.uploads.models import GenericFile
from dj.apps.uploads.serializers import FeaturedImageSerializer

from dj.apps.otp.utils import (
    INVALID_OTP_TOKEN_MESSAGE,
    TOTP_ATTEMPT_LIMIT,
    TOTP_ATTEMPT_TTL_SECONDS,
    check_user_totp,
    claim_totp_attempt,
    clear_totp_attempt,
    has_active_totp,
    verify_user_totp,
)

UserModel = get_user_model()


def public_zpage_count(creator):
    """Count only pages that the public profile is allowed to name."""
    return zPage.objects.published_and_active().filter(
        creator=creator,
    ).count()


class TotpAttemptStoreUnavailable(APIException):
    status_code = 503
    default_detail = 'Password change is temporarily unavailable.'
    default_code = 'service_unavailable'


class CaptchaServiceUnavailable(APIException):
    """siteverify timed out or answered garbage: refuse the login, as a 503.

    Fail closed. A 503 rather than the usual "Invalid captcha" 400 so
    the failure is attributable in logs and metrics to the provider, not to
    the user's solve; the message still names reCAPTCHA so the front ends'
    ``isCaptchaError`` tells the user to try again.
    """
    status_code = 503
    default_detail = CAPTCHA_UNAVAILABLE_MESSAGE
    default_code = 'captcha_unavailable'


def require_current_password(user, old_password, request=None):
    """Refuse a password change that cannot prove the CURRENT password.

    Split out because it is called twice on purpose (see
    `CreatorPasswordChangeSerializer.custom_validation`): once cheaply before
    any second factor is spent, and once against the account row read under
    the lock that already guards the write.

    Deliberately NOT `user.check_password()`: Django's model method hands the
    hasher a setter that transparently re-hashes and SAVES an outdated
    encoding. That write used to commit even when this request went on to
    fail (AtomicMiddleware saw a handled 400, not an exception; fixed in
     for RAISED errors, but a view that RETURNS a 400 still commits) --
    and re-hashing rotates `get_session_auth_hash()`, so a user who mistyped
    their authenticator code would be silently logged out of every session.
    Login remains the place hashes get upgraded.
    """
    if not user.has_usable_password():
        # A first password is a new sign-in method. The caller must have
        # recently proved a previously linked provider or wallet.
        require_recent_auth(request)
        return
    if not old_password:
        raise serializers.ValidationError({
            'old_password': [_('This field is required.')],
        })
    if not check_password(old_password, user.password):
        raise serializers.ValidationError({
            'old_password': [_('Incorrect password.')],
        })


class CreatorSetPasswordForm(SetPasswordForm):
    """Set only password-owned columns, then discard stale user state."""

    def save(self, commit=True):
        if not commit:
            return super().save(commit=False)

        with transaction.atomic():
            # Password changes, reset issuance, and reset redemption all take
            # this account lock first. Replace the authentication-loaded form
            # instance before hashing/saving so this path participates in the
            # same ordering protocol.
            request_user = self.user
            self.user = Creator.objects.select_for_update().get(
                pk=request_user.pk
            )
            # THE authoritative current-password check, under the lock that
            # already guards this write. The serializer's earlier
            # check ran against `request.user`, which authentication may have
            # loaded before a concurrent password change committed -- accepting
            # a password the account no longer has is the stale-write shape of
            #. Re-checked here rather than by taking a second lock in the
            # serializer, because a Creator-then-OTPSecret lock order would
            # invert the OTPSecret-then-Creator order `/api/auth/login/` takes
            # (it consumes the TOTP under the OTPSecret lock, then Django's
            # login writes `last_login`) and the two would deadlock under
            # concurrency. Found by the codex adversarial review.
            require_current_password(
                self.user, self.data.get('old_password'), getattr(self, 'auth_request', None),
            )
            user = super().save(commit=False)
            user.save(
                update_fields={'password', 'password_set', 'updated_at'}
            )
            PasswordResetToken.objects.filter(
                email__user_id=user.pk,
                used=False,
            ).update(used=True)
            # An account-ownership event, for the same reason as the
            # sibling /api/emails/change-password route. Note the ordering
            # below is load-bearing: the bump must happen BEFORE the two
            # `refresh_from_db` calls, or both instances would be resynced to
            # the pre-increment value and hand a stale counter to whatever
            # reads them next. `Creator.save()` already excludes the column
            # from full saves, so the increment itself cannot be clobbered.
            bump_account_epoch(user.pk, event=EVENT_PASSWORD_CHANGE)
            # dj-rest-auth keeps using the returned instance to update the
            # session. Do not leave stale privileges or moderation state on
            # it. Keeping the refresh in the transaction also prevents a
            # committed password change followed by a refresh failure.
            user.refresh_from_db(using=user._state.db)
            request_user.refresh_from_db(using=user._state.db)
        return user


class CreatorPasswordChangeSerializer(PasswordChangeSerializer):
    otp_token = serializers.CharField(
        required=False,
        write_only=True,
        max_length=10,
        help_text="Current authenticator code for an account with MFA.",
    )
    set_password_form_class = CreatorSetPasswordForm

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # dj-rest-auth's PasswordChangeSerializer.__init__ POPS `old_password`
        # from the field set whenever REST_AUTH['OLD_PASSWORD_FIELD_ENABLED']
        # is falsy -- which it is, and which is exactly how this route came to
        # accept a full password replacement from a session alone, with no
        # proof of the current password. Put the field back after
        # super() has run, because super() is what removed it.
        #
        # It is re-added as required=False, NOT by flipping the dj-rest-auth
        # setting, because that setting makes the field unconditionally
        # required: accounts created through Zcash/social/Twitter sign-in have
        # `set_unusable_password()` and no old password to present, so an
        # unconditional requirement would permanently lock them out of ever
        # setting one. Whether it is required is decided per account in
        # _validate_old_password(), the same rule /api/emails/change-password
        # already applies (dj.apps.emails.serializers.ChangePasswordSerializer).
        #
        # `max_length` is 4096, not upstream's 128 (codex review): the sibling
        # /api/emails/change-password imposes no maximum, so an account can
        # legitimately hold a longer password than this route would ever
        # create, and a 128 cap would reject the correct current password with
        # a schema error before it was ever checked -- locking that account
        # out of rotating its password here. It is still bounded so an
        # arbitrarily long string cannot be fed to the hasher.
        self.fields['old_password'] = serializers.CharField(
            required=False,
            write_only=True,
            max_length=4096,
            help_text=(
                "Current password. Required for any account that has one; "
                "omit only for an account that has never set a password."
            ),
        )

    def validate_old_password(self, value):
        """Disarm dj-rest-auth's inherited, MUTATING field validator.

        Raised by the codex adversarial review of this change. Upstream's
        `PasswordChangeSerializer.validate_old_password` builds a plain tuple:

            invalid_password_conditions = (
                self.old_password_field_enabled,
                self.user,
                not self.user.check_password(value),
            )

        Python evaluates every element, so `self.user.check_password()` runs
        even though `old_password_field_enabled` is False and the result is
        discarded -- and the model's `check_password()` hands the hasher a
        setter that re-hashes and SAVES an outdated encoding. Re-adding the
        field in `__init__` therefore re-armed exactly the side effect the
        locked-row check below was written to avoid. It fires during field
        validation, before anything here runs. (It used to commit with the
        handled 400; a raised ValidationError rolls the request
        back, but a hash rewrite must not depend on that.) Verification lives in `require_current_password()`, which never
        writes; this override exists so upstream's copy never executes.
        """
        return value

    def validate(self, attrs):
        """Reject an unusable new password BEFORE any second factor is spent.

        Upstream `validate()` calls `custom_validation()` first and only then
        checks `set_password_form.is_valid()`. With a TOTP gate hanging off
        `custom_validation` that ordering burns a single-use code  and
        *then* rejects the request for a weak or mismatched new password,
        locking the user out of retrying until the next time step for a
        mistake that never touched their credentials. This is the same
        property the login path already holds -- see
        test_totp_is_consumed_only_after_login_validation_fully_passes.

        Everything else about upstream's contract is preserved: the form is
        still built from `attrs`, still stored on `self` for `save()`, and its
        errors are still raised as-is.
        """
        self.set_password_form = self.set_password_form_class(
            user=self.user, data=attrs,
        )
        self.set_password_form.auth_request = self.context.get('request')
        if not self.set_password_form.is_valid():
            raise serializers.ValidationError(self.set_password_form.errors)
        self.custom_validation(attrs)
        return attrs

    def custom_validation(self, attrs):
        super().custom_validation(attrs)
        # Order matters and is not incidental. The cheap, non-consuming proof
        # of the CURRENT password runs first, so a caller who does not have it
        # cannot spend the account's TOTP codes -- neither burning the current
        # step ( makes each code single-use) nor eating the bounded
        # attempt counter, which would otherwise be a trivial way to lock a
        # victim out of their own password change.
        #
        # This pass reads `self.user` (the authentication-loaded instance) and
        # takes NO lock, so it cannot be the last word: a concurrent password
        # change may have committed since. `CreatorSetPasswordForm.save()`
        # repeats it against the row it locks, and that repeat is the
        # authoritative one. Two cheap checks rather than one lock here,
        # because locking Creator before OTPSecret would invert the order
        # `/api/auth/login/` uses and deadlock against it (codex review).
        require_current_password(self.user, attrs.get('old_password'), self.context.get('request'))
        self._verify_totp(attrs, self.user)

    def _verify_totp(self, attrs, user):
        if not has_active_totp(user):
            return

        attempt = claim_totp_attempt(
            'password-change',
            user.pk,
            TOTP_ATTEMPT_TTL_SECONDS,
        )
        if attempt is None:
            raise TotpAttemptStoreUnavailable()
        if attempt > TOTP_ATTEMPT_LIMIT:
            raise Throttled()
        if not verify_user_totp(user, attrs.get('otp_token')):
            if attempt == TOTP_ATTEMPT_LIMIT:
                raise Throttled()
            raise serializers.ValidationError({
                'otp_token': [INVALID_OTP_TOKEN_MESSAGE],
            })
        clear_totp_attempt('password-change', user.pk)


class TwitterProfileSummarySerializer(serializers.Serializer):
    """The public Twitter identity embedded in the private profile response."""

    id = serializers.CharField()
    name = serializers.CharField()
    username = serializers.CharField()


class RegistrationSerializer(serializers.ModelSerializer):

    class Meta:
        model = Creator
        fields = ['username', 'password']

    def validate_username(self, value):
        if Creator.objects.filter(username__iexact=value).exists():
            raise serializers.ValidationError(
                "A user with that username already exists!")
        if is_forbidden_username(value):
            raise serializers.ValidationError(
                "System reserved name, please choose another!")
        return value

    def validate_password(self, value):
        password_validation.validate_password(value, Creator)
        return value


class CreatorProfileUpdateSerializer(UserDetailsSerializer):
    """
    This is the creator's ~private data.

    This is only for self!

    Do not use this serializer for applications which
    are not reserved for the creator themselves.
    """

    zpage_set = serializers.HiddenField(default=zPage.objects.none())
    zpages = serializers.IntegerField(
        source="zpage_set.count",
        read_only=True,
        help_text=(
            "Private owner count: includes this creator's published pages "
            "and drafts. Public creator list/detail `zpages` counts are "
            "published-and-active only."
        ),
    )
    updateAll = serializers.BooleanField(
        write_only=True,
        required=False,
        default=False,
    )

    # Who you are subscribed to. Kept as a list because the UI genuinely reads
    # membership from it (`stars.includes(username)` gates the subscribe button
    # on every creator/stream page) and it is bounded by the viewer's own
    # spending, not by someone else's popularity.
    stars = serializers.SerializerMethodField('get_stars')
    # Immutable ids accompany the username list so client-side paid intent
    # cleanup can address a creator after a rename without treating a reused
    # username as the same recipient.
    star_ids = serializers.SerializerMethodField('get_star_ids')
    # How many creators are subscribed to you. This used to be `fans`, the full
    # roster of subscriber usernames -- see get_fans_count for why it is a
    # number now.
    fans_count = serializers.SerializerMethodField('get_fans_count')
    # You username/id/name - only for you right now?
    twitter = serializers.SerializerMethodField()

    avatar_image = serializers.PrimaryKeyRelatedField(
        queryset=GenericFile.objects.none(), required=False, allow_null=True
    )
    banner_image = serializers.PrimaryKeyRelatedField(
        queryset=GenericFile.objects.none(), required=False, allow_null=True
    )

    # This serializer operates on the authenticated Creator instance. A bare
    # ModelSerializer update would therefore save every loaded model column,
    # including auth and moderation state that the client cannot submit. If a
    # staff demotion, ban, strike, or password reset lands after request.user
    # was loaded but before this PATCH saves, that full save restores the stale
    # value.
    #
    # Keep this an explicit allowlist rather than deriving it from Meta.fields:
    # adding a serializer field must not silently grant it write access. The
    # runtime check in update() makes such a change fail loudly until its write
    # ownership has been reviewed and added here deliberately.
    PROFILE_WRITE_FIELDS = frozenset({
        'username',
        'email',
        'first_name',
        'last_name',
        'p2paddr',
        'full_name',
        'description',
        'member_price',
        'avatar_image',
        'banner_image',
    })

    class Meta:
        fields = [
            'id', 'username', 'email', 'first_name', 'last_name',
            'p2paddr',
            'total',
            'is_verified',
            'zpage_set', 'zpages',
            'updateAll',
            'tuzis',
            'full_name',
            'description',
            'can_stream',
            'member_price',
            'stars',
            'star_ids',
            'fans_count',
            'twitter',
            'avatar_image',
            'banner_image',
        ]
        read_only_fields = [
            'id', 'total', 'zpage_set', 'is_verified',
            'tuzis', 'can_stream', 'stars', 'star_ids', 'fans_count',
        ]
        model = Creator
        extra_fields = ['updateAll']

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        request = self.context.get('request')
        user = getattr(request, 'user', None)
        if user is not None and user.is_authenticated:
            self.fields['avatar_image'].queryset = GenericFile.objects.filter(
                owner=user)
            self.fields['banner_image'].queryset = GenericFile.objects.filter(
                owner=user)

    def validate_avatar_image(self, value):
        if value:
            if not value.mime_type.startswith('image/'):
                raise serializers.ValidationError(
                    "The featured image must have image mime_type")

            if value.access != "public":
                raise serializers.ValidationError(
                    "The featured image must have access set to 'public'")

        return value

    def validate_banner_image(self, value):
        if value:
            if not value.mime_type.startswith('image/'):
                raise serializers.ValidationError(
                    "The featured image must have image mime_type")

            if value.access != "public":
                raise serializers.ValidationError(
                    "The featured image must have access set to 'public'")

        return value

    def validate_username(self, value):
        instance: Creator = getattr(self, 'instance', None)
        # Route names added after an account was created are grandfathered:
        # the owner may keep the current username, but cannot rename into a
        # reserved namespace. Compare case-insensitively because username
        # uniqueness and the route namespace do the same.
        retaining_current_username = (
            instance is not None
            and instance.username.lower() == value.lower()
        )
        if (
            is_forbidden_username(value)
            and not retaining_current_username
        ):
            raise serializers.ValidationError(
                "System reserved name, please choose another!")
        if Creator.objects.filter(
            username__iexact=value
        ).exclude(id=instance.id):
            raise serializers.ValidationError(
                "A user with that username already exists!")
        return value

    @extend_schema_field(serializers.ListField(child=serializers.CharField()))
    def get_stars(self, instance):
        """The creators you are currently subscribed to.

        `star__is_active` because this list NAMES accounts .
        Deactivating a creator 404s their profile and every zPage, yet
        their username kept coming back here on every session -- and the UI
        does `stars.includes(username)`, so a taken-down creator also kept
        rendering as "subscribed" wherever that gate is read. The
        Subscription row is untouched: this is what the API shows, not what
        the fan is owed.
        """
        subscriptions = self._active_subscriptions(instance)
        return [username for username, _ in subscriptions]

    def _active_subscriptions(self, instance):
        cache_name = '_active_subscription_identity_pairs'
        cached = getattr(instance, cache_name, None)
        if cached is not None:
            return cached
        subscriptions = list(Subscription.objects.filter(
            fan=instance,
            star__is_active=True,
            expires__gte=timezone.now()
        ).order_by('star_id').values_list('star__username', 'star_id'))
        setattr(instance, cache_name, subscriptions)
        return subscriptions

    @extend_schema_field(serializers.ListField(child=serializers.IntegerField()))
    def get_star_ids(self, instance):
        return [star_id for _, star_id in self._active_subscriptions(instance)]

    @extend_schema_field(serializers.IntegerField())
    def get_fans_count(self, instance):
        """How many creators are currently subscribed to you.

        This replaced a ``fans`` field that returned every subscriber's
        username. ``GET /api/auth/user/`` is hit on every session, and
        the only consumer of that array was ``fans.length`` rendered into a
        dashboard tile -- so the response size of a hot endpoint was governed
        by how successful the creator was. It also meant a creator's own
        session payload carried a roster of *other* people's usernames for no
        reason; the paginated ``GET /api/tuzis/my-subscribers`` already serves
        that roster properly, with richer rows, when it is actually wanted.

        Prefer a ``fans_count`` annotation put on the instance by the view (see
        ``CustomUserDetailsView.get_object``) so the read costs no extra query.
        Fall back to ``COUNT(*)`` in the database -- never ``len()`` over a
        materialised queryset, which would shrink the response while keeping
        the cost that was the whole problem.
        """
        annotated = getattr(instance, 'fans_count', None)
        if annotated is not None:
            return annotated
        return instance.get_fans().count()

    @extend_schema_field(TwitterProfileSummarySerializer(allow_null=True))
    def get_twitter(self, obj):
        from dj.apps.twitter.models import TwitterProfile
        try:
            twitter_profile = obj.twitter_profile
            return {
                'id': twitter_profile.twitter_id,
                'name': twitter_profile.name,
                'username': twitter_profile.username
            }
        except TwitterProfile.DoesNotExist:
            return None

    def update(self, instance, validated_data):
        user = None
        request = self.context.get("request")
        if request and hasattr(request, "user"):
            user = request.user
        if not user:
            return

        update_all = validated_data.pop('updateAll', False)
        # HiddenField defaults are included for a full PUT. zpage_set is
        # response bookkeeping, not an owned model column or relationship
        # mutation for this endpoint.
        validated_data.pop('zpage_set', None)
        unexpected_fields = set(validated_data) - self.PROFILE_WRITE_FIELDS
        if unexpected_fields:
            raise AssertionError(
                "Creator profile update attempted unapproved model fields: "
                + ", ".join(sorted(unexpected_fields))
            )

        for field, value in validated_data.items():
            setattr(instance, field, value)

        # updated_at is auto_now, but Django only evaluates it when it appears
        # in update_fields. All other columns stay untouched in the database,
        # so a stale request cannot undo a concurrent security decision.
        with transaction.atomic():
            # The database trigger compares these exact persisted columns to
            # OLD and stamps only an actual public-content change. Keep this
            # write set explicit: stale auth/security fields never join it.
            instance.save(update_fields={*validated_data, 'updated_at'})

            if update_all:
                # inherits the p2paddr from the creator
                zPage.objects.filter(creator=user).update(p2paddr="")

            # The row is safe now, but request.user still holds every stale
            # value it had when authentication loaded it. Reload from the write
            # database both for later in-request permission checks and because
            # DRF serializes this same object into the PATCH response (including
            # server-owned balance/trust fields). The transaction makes a
            # refresh failure roll back the profile edit instead of returning
            # 500 after claiming it failed when it actually committed.
            instance.refresh_from_db(using=instance._state.db)
        return instance


class CreatorProfileDetailSerializer(CreatorProfileUpdateSerializer):
    """
    Only for the owner, show everything
    """
    avatar_image = FeaturedImageSerializer(allow_null=True, required=False)
    banner_image = FeaturedImageSerializer(allow_null=True, required=False)
    balance_snapshot = serializers.CharField(
        read_only=True,
        required=False,
        help_text=(
            'Active PostgreSQL snapshot of this committed 2Z balance, encoded '
            'as canonical decimal xmax:xip_count. Compare xmax ascending as '
            'an unsigned 64-bit integer, then xip_count descending. Applies '
            'to read-only observations from the same database; absent on '
            'representations without a balance snapshot.'
        ),
    )

    class Meta(CreatorProfileUpdateSerializer.Meta):
        fields = [*CreatorProfileUpdateSerializer.Meta.fields, 'balance_snapshot']


class CreatorProfileDetailSchema(OpenApiSerializerExtension):
    """Read-only snapshot metadata is optional on non-GET representations."""

    target_class = CreatorProfileDetailSerializer

    def map_serializer(self, auto_schema, direction):
        schema = auto_schema._map_serializer(
            self.target, direction, bypass_extensions=True,
        )
        schema['required'] = [
            name for name in schema.get('required', [])
            if name != 'balance_snapshot'
        ]
        return schema


class AnnotationFlagField(serializers.BooleanField):
    """A read-only boolean backed by an optional queryset annotation.

    ``BooleanField(read_only=True, default=False)`` does NOT reliably answer
    ``False`` for an un-annotated instance: DRF's ``Field.get_default`` raises
    ``SkipField`` whenever the ROOT serializer is ``partial``, so the key
    vanished from every PATCH response that nests the creator (: the
    conversation PATCH answered ``user`` without ``is_live`` while the GET had
    it). Reading the attribute directly keeps the key present on every
    action; the schema is unchanged (still a read-only boolean).
    """

    def __init__(self, **kwargs):
        kwargs.setdefault("read_only", True)
        kwargs.setdefault("default", False)
        super().__init__(**kwargs)

    def get_attribute(self, instance):
        return bool(getattr(instance, self.source_attrs[-1], self.default))


class CreatorListSerializer(UserDetailsSerializer):
    """
    Listing page serializer for Creators
    """
    avatar_image = FeaturedImageSerializer(allow_null=True)
    banner_image = FeaturedImageSerializer(allow_null=True)
    zpages = serializers.SerializerMethodField()
    # Backed by the `is_live` annotation on CreatorView's list querysets (a
    # single indexed Exists() subquery — no N+1). An un-annotated instance
    # answers False, on every action including a partial update's response.
    is_live = AnnotationFlagField()

    class Meta:
        fields = [
            'id',
            'username',
            'total',
            'is_verified',
            'zpages',
            'avatar_image',
            'banner_image',
            'full_name',
            'p2paddr',
            'member_price',
            'is_live',
            # TODO: maybe strip markdown and/or truncate?
            # dont need for now
            # 'description',
        ]
        # read_only_fields = ['total', 'zpage_set']
        model = Creator
        extra_fields = []
        # The column is NOT NULL since, but a deactivated creator's
        # price is redacted to null below -- keep the schema honest.
        extra_kwargs = {'member_price': {'allow_null': True}}

    @extend_schema_field(serializers.IntegerField())
    def get_zpages(self, instance):
        annotated = getattr(instance, 'published_pages', None)
        return annotated if annotated is not None else public_zpage_count(instance)

    def to_representation(self, instance):
        # Issue: this serializer nests into public AI-conversation
        # payloads (PromptResponse.user), including rows copied into forks,
        # where visibility is governed by the CONVERSATION owner -- never by
        # the response AUTHOR's own activity. A deactivated creator keeps
        # their transcript but loses their private identity here: no real
        # name, Zcash address, membership price, or profile media (whose
        # metadata and URLs can identify the creator). The username stays as
        # the stable public attribution for the retained transcript row.
        data = super().to_representation(instance)
        if not instance.is_active:
            data['full_name'] = ''
            data['p2paddr'] = ''
            data['member_price'] = None
            data['avatar_image'] = None
            data['banner_image'] = None
        return data


class CreatorDetailSerializer(UserDetailsSerializer):
    """
    Creator detail serializer
    """
    zpages = serializers.SerializerMethodField()
    avatar_image = FeaturedImageSerializer()
    banner_image = FeaturedImageSerializer()
    # Backed by the `is_live` annotation on CreatorView's retrieve queryset (a
    # single indexed Exists() subquery). Lets the "Watch live" button gate
    # synchronously with no extra request. `default=False` is a safety net for
    # any un-annotated serialization path.
    is_live = serializers.BooleanField(read_only=True, default=False)
    # `dateCreated` on the ProfilePage JSON-LD  is recommended by
    # Google and was previously blocked on the backend not exposing it. The
    # field already exists on the model -- `date_joined` from Django's
    # AbstractUser -- so this is a serializer-only change, no migration.
    #
    # `updated_at` is deliberately NOT exposed here for `dateModified`, even
    # though it also already exists on the model and Google recommends that
    # property too: `updated_at` advances on ANY save of the row, including
    # private security operations with nothing to do with the public
    # profile -- e.g. `CreatorSetPasswordForm.save()` bumps it on every
    # password change. Publishing it on this anonymous, unauthenticated
    # endpoint would let anyone poll a creator's public profile to learn the
    # exact moment of their last account change of ANY kind.
    # `dateModified` needs a timestamp scoped to public-facing edits only --
    # `public_profile_updated_at`, which is changed only when a creator's
    # public-facing profile fields actually change. It is serialized at day
    # precision for the same privacy reason as `date_joined`.
    #
    # DAY precision, not the full timestamp. The same disclosure standard
    # applied to `updated_at` above applies here: this is an anonymous,
    # unauthenticated endpoint, `dateCreated` needs nothing finer than a day,
    # and the exact instant of signup is a correlation handle -- it joins a
    # profile to whatever else happened in that second (a payment, a log line,
    # another account created from the same session). Serializes as
    # `2026-09-06` -- the API's deliberate day-only contract (`format: date`)
    # in the spec. The JSON-LD
    # consumer expands this to UTC midnight because Google's ProfilePage
    # parser requires a DateTime; that synthetic boundary does not disclose
    # the signup instant. See `get_date_joined`.
    date_joined = serializers.SerializerMethodField()
    date_modified = serializers.SerializerMethodField()

    class Meta:
        fields = [
            'id',
            'username',
            'total',
            'is_verified',
            'zpages',
            'avatar_image',
            'banner_image',
            'full_name',
            'description',
            'p2paddr',
            'can_stream',
            'member_price',
            'is_live',
            'date_joined',
            'date_modified',
        ]
        model = Creator
        extra_fields = []

    @extend_schema_field(serializers.IntegerField())
    def get_zpages(self, instance):
        annotated = getattr(instance, 'published_pages', None)
        return annotated if annotated is not None else public_zpage_count(instance)

    @extend_schema_field(serializers.DateField())
    def get_date_joined(self, obj):
        joined = getattr(obj, 'date_joined', None)
        if not joined:
            return None
        # settings.TIME_ZONE is 'UTC' with USE_TZ on, so the stored value is
        # UTC-aware and `.date()` is an unambiguous calendar day. (DRF's own
        # DateField refuses to coerce a datetime for exactly the timezone
        # reason -- doing it here makes the choice of timezone explicit
        # instead of implicit.)
        return joined.date().isoformat()

    @extend_schema_field(serializers.DateField(allow_null=True))
    def get_date_modified(self, obj):
        modified = getattr(obj, 'public_profile_updated_at', None)
        if not modified:
            return None
        return modified.date().isoformat()


class CreatorLoginSerializer(LoginSerializer):
    email = None
    captcha_result = serializers.CharField()
    otp_token = serializers.CharField(required=False, write_only=True)

    def validate(self, attrs):
        # captcha_result = "foobar"
        captcha_result = attrs.pop('captcha_result', '')
        otp_token = attrs.pop('otp_token', None)  # Pop the OTP token from attrs
        # print("=========================================")
        # print('otp_token', otp_token)
        # Development bypass: mirror SignUpView logic allowing a stub token when DEBUG
        #
        #  -- a second, identity-bound bypass lets the deployment
        # smoke-test account log in without reCAPTCHA. Two independent gates
        # make it safe to ship the account name in the shared ConfigMap:
        #   * the request's username must equal
        #     settings.SMOKE_TEST_ACCOUNT_USERNAME (compared case-insensitively,
        #     matching get_auth_user_using_orm's username__iexact lookup below);
        #   * the pod must run in the stage namespace -- read live from
        #     os.environ, so the value the shared ConfigMap delivers to BOTH
        #     stage and prod via envFrom stays inert outside stage. Fails
        #     closed on every other environment.
        username = attrs.get('username') or ''
        smoke_username = getattr(settings, 'SMOKE_TEST_ACCOUNT_USERNAME', '')
        if (
            username
            and username.lower() == smoke_username.lower()
            and os.environ.get('NAMESPACE') == 'stage'
        ):
            recaptcha_success = True
        elif settings.DEBUG and captcha_result == 'test':
            recaptcha_success = True
        else:
            # Bounded, and fail-closed on no answer: see
            # dj.apps.g12f.captcha.siteverify.
            try:
                payload = siteverify(captcha_result)
            except CaptchaUnavailable:
                raise CaptchaServiceUnavailable()
            #. This used to be:
            #
            #     error_code = r.json().get('error-codes', ['foobar'])[0]
            #     recaptcha_success = (
            #         r.json().get('success')
            #         or error_code == 'timeout-or-duplicate'
            #     )
            #
            # i.e. a token Google had already redeemed (or that had expired)
            # counted as a pass, forever, so one solved CAPTCHA authorised
            # unlimited credential stuffing here. The duplicate branch is still
            # needed -- every client POSTs /api/start/ with this same token
            # first, and MFA re-POSTs it once per typed OTP code -- so it is
            # now bounded by a server-side grant instead of being unconditional.
            # See dj/apps/g12f/captcha.py.
            recaptcha_success = verify_captcha_response(
                payload, captcha_result, allow_replay=True
            )

        if not recaptcha_success:
            # Wording kept verbatim: both front ends classify a captcha
            # failure by regex on the message (`isCaptchaError` in
            # lib/stores/auth.ts) and an expired grant must keep landing in
            # that branch, which tells the user to try again -- retrying is
            # exactly right, because it mints a fresh token.
            raise ValidationError("Invalid captcha")

        # Self-service deletion's grace period: ModelBackend refuses every
        # inactive account, so a pending one is recognised here -- right
        # password, account in its grace period, nothing else -- and answered
        # with a keep token instead of a session (409 deletion_pending). The
        # TOTP is verified (and burned) first, so a keep token always carries
        # the same proof a session would have. The password is hashed ONCE
        # for such an account, as for any other (no timing tell), and a
        # wrong one gets upstream's exact refusal. DeletionPending is not an
        # API error: CreatorLoginView RETURNS the 409, so the burned TOTP
        # code commits (a raised error would roll it back).
        from dj.apps.g12f import account_deletion
        from dj.apps.identity.auth_context import AMR_PASSWORD

        pending = account_deletion.keepable_account_for_username(username)
        if pending is not None:
            if not pending.check_password(attrs.get('password') or ''):
                raise serializers.ValidationError(
                    _('Unable to log in with provided credentials.'))
            gate = check_user_totp(pending, otp_token)
            if not gate.passed:
                raise ValidationError("Invalid OTP token")
            account_deletion.login_gate(
                pending, methods=[AMR_PASSWORD],
                second_factor=gate.second_factor, credential="session",
            )

        inactive = account_deletion.inactive_account_for_username(username)
        if inactive is not None:
            if not inactive.check_password(attrs.get('password') or ''):
                raise serializers.ValidationError(
                    _('Unable to log in with provided credentials.'))
            try:
                account_deletion.ensure_account_can_sign_in(inactive)
            except account_deletion.InactiveAccount as exc:
                raise serializers.ValidationError(exc.detail) from exc

        # Let the upstream LoginSerializer run its single authentication
        # pass -- password check, account-status and email-verification
        # gates, everything that can still deny this login -- BEFORE the
        # irreversible TOTP consume. Consuming first meant a
        # concurrent password change, account-state flip, or backend error
        # during validate() denied the session with the code already burned.
        validated = super().validate(attrs)

        user = validated.get('user')
        if user:
            # Only now is a successful login assured: validate AND burn the
            # OTP token. A code accepted here is dead for its step, so it can
            # never be replayed onto another TOTP-gated route. A wrong
            # password never reaches this line, so it burns nothing.
            # Accounts without an active secret pass straight through.
            gate = check_user_totp(user, otp_token)
            if not gate.passed:
                raise ValidationError("Invalid OTP token")
            # Read by CreatorLoginView.process_login for the session's
            # AuthContext: "otp" only when a code was verified here.
            validated['second_factor'] = gate.second_factor

        return validated

    def get_auth_user_using_orm(self, username, email, password):
        if email:
            try:
                user = UserModel.objects.get(email__iexact=email)
                username = user.get_username()
            except UserModel.DoesNotExist:
                pass

        if username:
            try:
                user = UserModel.objects.get(username__iexact=username)
                return self._validate_username_email(
                    user.get_username(), '', password)
            except UserModel.DoesNotExist:
                pass

        return None
