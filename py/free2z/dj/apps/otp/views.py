import urllib.parse

from django.contrib.auth import authenticate, login
from django.db import transaction

from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.throttling import UserRateThrottle

from dj.free2z.throttling import (
    FailClosedAuthThrottleMixin,
    FailOpenThrottleMixin,
)
from .models import OTPSecret
from .serializers import VerifyOTPSerializer
from dj.apps.identity.auth_context import AMR_PASSWORD, record_login

from .utils import check_user_totp, consume_token, generate_secret


class BruteRateThrottle(
    FailClosedAuthThrottleMixin, FailOpenThrottleMixin, UserRateThrottle
):
    """One-per-second brake on every TOTP endpoint, including OTP login.

    A credential scope, so it fails CLOSED on a counter-store outage:
    ``LoginWithOTPView`` accepts a username and a six-digit code with no
    captcha, and an unthrottled lane there is a million-guess search space.
    DRF's ``UserRateThrottle`` keys an anonymous caller on its address, which
    is what makes this a per-source control on that view at all.
    """

    scope = 'brute'


# NOTE: keep SetupOTPView's docstring short. drf-spectacular publishes it
# verbatim as the endpoint `description` in f2z.yaml and the generated TS
# client, so the reasoning below lives in a comment instead.
#
# Security: this view used to be a bare
# `OTPSecret.objects.get_or_create(...)` that unconditionally echoed
# `otp_secret.secret` back. For an account that had *already* enrolled,
# get_or_create returns the EXISTING row -- so any authenticated caller could
# re-POST to the enrolment endpoint and be handed the account's ACTIVE TOTP
# seed. That promotes one authenticated request into an indefinite
# second-factor compromise: the seed mints valid codes forever, survives a
# password reset, appears in no audit trail the user sees, and is only closed
# by the user noticing and re-enrolling.
#
# A TOTP secret is a long-term credential, so it is disclosed exactly once, to
# the person setting up an authenticator that has not been verified yet:
#
#   * MFA already active -> 409, no seed anywhere in the body. Disabling MFA
#     first is the deliberate, second-factor-gated step that makes
#     re-enrolment safe (DisableOTPView).
#   * A pending, never-verified enrolment -> a FRESH seed replaces it rather
#     than the pending one being disclosed a second time, so one QR code
#     belongs to exactly one enrolment attempt.
#
# The read/compare/write runs under select_for_update because losing a race
# with EnableOTPView would itself be a disclosure: read is_active=False, a
# concurrent enable flips it True, and this view then writes and returns a
# seed for an account whose MFA is now on.
class SetupOTPView(APIView):
    """Begin MFA enrolment and return a new, unverified TOTP secret.

    Refuses with 409 when MFA is already enabled; an active secret is never
    returned.
    """

    permission_classes = [IsAuthenticated]

    def post(self, request):
        user = request.user

        with transaction.atomic():
            otp_secret, created = (
                OTPSecret.objects.select_for_update().get_or_create(
                    user=user,
                    defaults={'secret': generate_secret(), 'is_active': False},
                )
            )
            if not created:
                if otp_secret.is_active:
                    return Response(
                        {
                            "message": (
                                "MFA is already enabled for this account. "
                                "Disable it before enrolling a new "
                                "authenticator."
                            )
                        },
                        status=status.HTTP_409_CONFLICT,
                    )
                otp_secret.secret = generate_secret()
                # The rotation must also clear any recorded consumption so a
                # newly rotated enrolment is never blocked by the OLD
                # secret's timestamp.
                otp_secret.last_used_at = None
                otp_secret.save(update_fields=['secret', 'last_used_at'])

        issuer_name = "Free2Z"
        account_name = urllib.parse.quote(user.username)
        otp_uri = f"otpauth://totp/{issuer_name}:{account_name}?secret={otp_secret.secret}&issuer={issuer_name}"
        return Response({
            "otp_uri": otp_uri,
            "secret": otp_secret.secret,
        }, status=status.HTTP_201_CREATED)


class RetrieveOTPStatusView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        user = request.user
        otp_secret_exists = OTPSecret.objects.filter(
            user=user, is_active=True
        ).exists()
        return Response({"enabled": otp_secret_exists})


class EnableOTPView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [BruteRateThrottle]

    def post(self, request):
        serializer = VerifyOTPSerializer(data=request.data)
        if serializer.is_valid():
            user = request.user
            token = serializer.validated_data['token']
            # print(token)
            try:
                # Locked and narrowed for the same reason SetupOTPView locks:
                # a bare `.save()` here rewrites every column, so a concurrent
                # setup that had just rotated the pending seed would be undone
                # and the OLD seed activated. Verify and flip only `is_active`,
                # under the same row lock.
                with transaction.atomic():
                    otp_secret = OTPSecret.objects.select_for_update().get(
                        user=user
                    )
                    # consume_token verifies AND burns the code under this
                    # same row lock: the code that activates MFA is
                    # single-use like any other, so it cannot be replayed
                    # within its step.
                    if consume_token(otp_secret, token):
                        otp_secret.is_active = True
                        otp_secret.save(update_fields=['is_active'])
                        verified = True
                    else:
                        verified = False
                if verified:
                    return Response({"message": "Verification successful."})
                else:
                    return Response({"message": "Invalid token."}, status=status.HTTP_400_BAD_REQUEST)
            except OTPSecret.DoesNotExist:
                return Response({"message": "OTP not set up."}, status=status.HTTP_404_NOT_FOUND)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)


class DisableOTPView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [BruteRateThrottle]

    def delete(self, request):
        user = request.user

        #  audit: the whole proof-then-delete runs under the row lock so
        # two concurrent disables serialize -- the loser sees the row already
        # gone and answers 400, and a TOTP proof can never be evaluated
        # against a secret that a concurrent request is mid-way through
        # deleting. Deleting inside the same transaction also keeps replay
        # structurally impossible: after a successful disable there is no
        # secret left to present the burned code to.
        with transaction.atomic():
            otp_secret = (
                OTPSecret.objects.select_for_update()
                .filter(user=user)
                .first()
            )
            if otp_secret is None:
                # Nothing to disable. Answer 400 rather than silently 200 so
                # a confused client doesn't believe it stripped a factor that
                # was never there.
                return Response(
                    {"message": "OTP is not enabled."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            # Disabling MFA is a security downgrade, so it must itself require a
            # second factor. Previously any authenticated request deleted the
            # secret, so a hijacked session (or a borrowed, already-logged-in
            # browser) could strip MFA with nothing but the cookie. Require either
            # a current TOTP token or the account password to prove the request
            # comes from the real account holder, not just a live session.
            #
            #  asked whether the password branch should go, on the grounds
            # that "the already-compromised password is not a second factor". It
            # stays for now, and the honest reason is a lockout, not a security
            # argument -- the codex adversarial review on that PR correctly shot
            # down the security argument, so here is the real state of things.
            #
            # Removing BasicAuthentication from DEFAULT_AUTHENTICATION_CLASSES did
            # close the password-ALONE path: reaching this line now costs a session
            # or a Knox token (test_basic_credentials_cannot_strip_mfa). Since
            #, the alternate session/token issuers (password reset, the
            # email magic link, the Twitter callback, social OAuth and Zcash
            # wallet login) all run the shared single-use TOTP gate, so holding
            # one of those credentials no longer implies an unchecked factor.
            # This endpoint still accepts the password branch for recovery
            # because no recovery codes exist yet.
            #
            # Deleting the branch anyway would lock people out rather than fix
            # that. There are no recovery codes, and login itself demands the TOTP
            # for an enrolled account, so "reset your password, get logged in, then
            # disable MFA with that password" IS the only route back for a user who
            # lost their authenticator. The attacker's path and the victim's path
            # are the same path; you cannot close one without the other.
            #
            # The next hardening step is recovery codes: only after they exist can
            # this password recovery branch be removed and disable require TOTP.
            token = request.data.get('token')
            password = request.data.get('password')

            authorized = False
            if token and consume_token(otp_secret, str(token)):
                # Burned under this same lock like every other consumer
                #a code already spent on another route this step
                # cannot authorize the downgrade here either.
                authorized = True
            elif password and user.check_password(password):
                authorized = True

            if not authorized:
                return Response(
                    {"message": "A valid current TOTP token or your account "
                                "password is required to disable MFA."},
                    status=status.HTTP_403_FORBIDDEN,
                )

            otp_secret.delete()

        return Response({"message": "OTP deleted successfully."})


class LoginWithOTPView(APIView):
    # A login endpoint: the caller is anonymous by definition.
    permission_classes = [AllowAny]
    # This isn't used on the front-end, but it's here for completeness
    # It does allow someone to log in with just a username and OTP token
    # and no Google reCAPTCHA which could be useful for CLI for example.
    throttle_classes = [BruteRateThrottle]

    def post(self, request):
        username = request.data.get('username')
        password = request.data.get('password')
        token = request.data.get('token')
        # The one inactive state a password may reach: an account in its
        # deletion grace period, answered with a keep token, never a
        # session (dj.apps.g12f.account_deletion.login_gate). Its password
        # is hashed once, instead of authenticate(), so a pending username
        # costs the same time as any other.
        from dj.apps.g12f import account_deletion

        pending = account_deletion.keepable_account_for_username(username)
        if pending is not None:
            if (
                pending.check_password(password or '')
                and OTPSecret.objects.filter(user=pending, is_active=True).exists()
            ):
                gate = check_user_totp(pending, token)
                if not gate.passed:
                    return Response({"message": "Invalid token."},
                                    status=status.HTTP_400_BAD_REQUEST)
                try:
                    account_deletion.login_gate(
                        pending, methods=[AMR_PASSWORD],
                        second_factor=gate.second_factor, credential="session",
                    )
                except account_deletion.DeletionPending as exc:
                    return account_deletion.deletion_pending_response(exc)
            return Response({"message": "Invalid credentials."},
                            status=status.HTTP_401_UNAUTHORIZED)
        inactive = account_deletion.inactive_account_for_username(username)
        if inactive is not None:
            if inactive.check_password(password or ''):
                try:
                    account_deletion.ensure_account_can_sign_in(inactive)
                except account_deletion.InactiveAccount as exc:
                    return Response(
                        {"message": exc.detail},
                        status=status.HTTP_403_FORBIDDEN,
                    )
            return Response({"message": "Invalid credentials."},
                            status=status.HTTP_401_UNAUTHORIZED)
        user = authenticate(username=username, password=password)

        if user is not None and OTPSecret.objects.filter(user=user, is_active=True).exists():
            # verify_user_totp  verifies AND burns the code under the
            # row lock: the same six digits cannot log in twice within one
            # time step, here or on any other TOTP-gated route.
            gate = check_user_totp(user, token)
            if gate.passed:
                login(request, user)
                record_login(
                    request, user,
                    methods=[AMR_PASSWORD],
                    second_factor=gate.second_factor,
                )
                # You can return a custom response or token here, depending on your front-end needs
                return Response({"message": "Login successful."}, status=status.HTTP_200_OK)
            else:
                return Response({"message": "Invalid token."}, status=status.HTTP_400_BAD_REQUEST)
        return Response({"message": "Invalid credentials."}, status=status.HTTP_401_UNAUTHORIZED)
