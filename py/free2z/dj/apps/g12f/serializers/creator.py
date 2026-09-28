import requests
from django.conf import settings
from django.utils.translation import gettext_lazy as _
from django.utils import timezone
from django.contrib.auth import password_validation
from django.core.exceptions import ValidationError
from django.contrib.auth import get_user_model

from rest_framework import serializers
from dj_rest_auth.serializers import LoginSerializer, UserDetailsSerializer

from dj.apps.g12f.models import Creator, zPage, Subscription
from dj.apps.uploads.models import GenericFile
from dj.apps.uploads.serializers import FeaturedImageSerializer

from dj.apps.otp.models import OTPSecret
from dj.apps.otp.utils import verify_token

UserModel = get_user_model()


# Reserved top-level names: a username equal to one of these would shadow a real
# page at /{username}. The site is mid-transition with BOTH UIs live, so this is
# the UNION of the real top-level route segments of the new SvelteKit UI
# (ts/svelte/free2z/src/routes/, incl. its (public)/ and (auth)/ route groups)
# and the classic React UI (ts/react/free2z/src/App.tsx), plus a few genuinely
# system-reserved names and the nginx UI-switch routes. Be conservative: when
# unsure whether a name is a live route, keep it reserved.
# TODO: once the classic React UI is retired, prune the classic-only entries
# (ai, begin, events, find, micvizz, profile, secretbackdrop, storytime, tools).
# See #567.
FORBIDDEN_USERNAMES = [
    # System / backend-reserved names
    "api",
    "adminzzz",
    "djstatic",
    "terms",
    "privacy-policy",
    # nginx UI-switch routes (only exist where both UIs are served)
    "try-new-ui",
    "classic-ui",
    # New SvelteKit UI top-level routes (routes/, (public)/, (auth)/)
    "article",
    "buy-2z",
    "checkout",
    "converse",
    "creators",
    "edit",
    "live",
    "login",
    "projects",
    "reset-password",
    "search",
    # Classic React UI top-level routes (App.tsx) — prune when classic retires
    "ai",
    "begin",
    "events",
    "find",
    "micvizz",
    "profile",
    "secretbackdrop",
    "storytime",
    "tools",
]


class RegistrationSerializer(serializers.ModelSerializer):

    class Meta:
        model = Creator
        fields = ['username', 'password']

    def validate_username(self, value):
        if value.lower() in FORBIDDEN_USERNAMES:
            raise serializers.ValidationError(
                "System reserved name, please choose another!")
        if Creator.objects.filter(username__iexact=value):
            raise serializers.ValidationError(
                "A user with that username already exists!")
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
    zpages = serializers.IntegerField(source="zpage_set.count", read_only=True)
    updateAll = serializers.BooleanField(write_only=True)

    # Who you are subscribed to
    stars = serializers.SerializerMethodField('get_stars')
    # Who is subscribed to you
    fans = serializers.SerializerMethodField('get_fans')
    # You username/id/name - only for you right now?
    twitter = serializers.SerializerMethodField()

    avatar_image = serializers.PrimaryKeyRelatedField(
        queryset=GenericFile.objects.none(), required=False, allow_null=True
    )
    banner_image = serializers.PrimaryKeyRelatedField(
        queryset=GenericFile.objects.none(), required=False, allow_null=True
    )

    class Meta:
        fields = [
            'username', 'email', 'first_name', 'last_name',
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
            'fans',
            'twitter',
            'avatar_image',
            'banner_image',
        ]
        read_only_fields = [
            'total', 'zpage_set', 'is_verified',
            'tuzis', 'can_stream', 'stars', 'fans',
        ]
        model = Creator
        extra_fields = ['updateAll']

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        if hasattr(self, 'context') and 'request' in self.context:
            request = self.context['request']
            self.fields['avatar_image'].queryset = GenericFile.objects.filter(
                owner=request.user)
            self.fields['banner_image'].queryset = GenericFile.objects.filter(
                owner=request.user)

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
        if value.lower() in FORBIDDEN_USERNAMES:
            raise serializers.ValidationError(
                "System reserved name, please choose another!")
        if Creator.objects.filter(
            username__iexact=value
        ).exclude(id=instance.id):
            raise serializers.ValidationError(
                "A user with that username already exists!")
        return value

    def get_stars(self, instance):
        """
        The subscriptions you own
        """
        stars = Subscription.objects.filter(
            fan=instance,
            expires__gte=timezone.now()
        ).values_list('star__username', flat=1)
        return list(stars)

    def get_fans(self, instance):
        """
        Creators subscribed to you
        """
        fans = Subscription.objects.filter(
            star=instance,
            expires__gte=timezone.now()
        ).values_list('fan__username', flat=1)
        return list(fans)

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
        res = super().update(instance, validated_data)
        if validated_data.get('updateAll'):
            # inherits the p2paddr from the creator
            zPage.objects.filter(creator=user).update(p2paddr="")
        return res


class CreatorProfileDetailSerializer(CreatorProfileUpdateSerializer):
    """
    Only for the owner, show everything
    """
    avatar_image = FeaturedImageSerializer()
    banner_image = FeaturedImageSerializer()


class CreatorListSerializer(UserDetailsSerializer):
    """
    Listing page serializer for Creators
    """
    avatar_image = FeaturedImageSerializer()
    banner_image = FeaturedImageSerializer()
    # zpage_set = serializers.HiddenField(default=zPage.objects.none())
    zpages = serializers.IntegerField(source="zpage_set.count", read_only=True)

    class Meta:
        fields = [
            'username',
            'total',
            'is_verified',
            'zpages',
            'avatar_image',
            'banner_image',
            'full_name',
            'p2paddr',
            'member_price',
            # TODO: maybe strip markdown and/or truncate?
            # dont need for now
            # 'description',
        ]
        # read_only_fields = ['total', 'zpage_set']
        model = Creator
        extra_fields = []


class CreatorDetailSerializer(UserDetailsSerializer):
    """
    Creator detail serializer
    """
    zpages = serializers.IntegerField(source="zpage_set.count", read_only=True)
    avatar_image = FeaturedImageSerializer()
    banner_image = FeaturedImageSerializer()

    class Meta:
        fields = [
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
        ]
        model = Creator
        extra_fields = []


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
        if settings.DEBUG and captcha_result == 'test':
            recaptcha_success = True
            error_code = None
        else:
            r = requests.post(
                'https://www.google.com/recaptcha/api/siteverify',
                data={
                    'secret': settings.RECAPTCHA_SECRET_KEY,
                    'response': captcha_result,
                }
            )
            # hack to reuse captcha from create
            error_code = r.json().get('error-codes', ['foobar'])[0]
            recaptcha_success = r.json().get('success') or error_code == 'timeout-or-duplicate'

        if not recaptcha_success:
            raise ValidationError("Invalid captcha")

        user = self.get_auth_user_using_orm(
            attrs.get('username'), attrs.get('email'), attrs.get('password'))

        # The whole thing depends on there being a user. HRM
        # print('--------------++++++++++++++')
        # print('user', user)
        if user:
            # If the user has OTP setup, validate the OTP token
            otp_secret = OTPSecret.objects.filter(user=user, is_active=True).first()
            if otp_secret and not verify_token(otp_secret.secret, otp_token):
                raise ValidationError("Invalid OTP token")

        return super().validate(attrs)

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
