"""``/api/auth/account-deletion/``: the API behind ``/account/delete``.

See :mod:`dj.apps.g12f.account_deletion` for what deleting does and why.

``GET`` reads what the confirmation screen states. ``POST`` requests the
deletion: the account goes inactive at once and is purged 30 days later
(``account_deletion.GRACE_PERIOD``); signing in before then, and choosing
"Keep my account", cancels it (``.../keep/``). Two proofs are required to
request it, and neither is an email: many accounts have none, by design, and
a burner account must be deletable like any other.

* A sign-in within the last five minutes (``require_recent_auth``) -- with a
  password, a provider, or the Zcash wallet, whichever the account uses. A
  stale session gets the same 401 ``insufficient_user_authentication`` every
  other step-up returns, and the page offers a fresh sign-in.
* ``confirm_username`` in the body must be the signed-in account's username.
  It is what the holder typed, and it binds the request to one account: a
  browser that switched persona in the re-authentication step cannot delete a
  different account from the one the screen showed.
"""
import logging

from django.contrib.auth import login, logout
from drf_spectacular.utils import (
    OpenApiParameter, OpenApiResponse, extend_schema, inline_serializer,
)
from rest_framework import serializers, status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from dj.apps.identity.auth_context import (
    RecentAuthenticationRequired, current_auth_context, record_login,
    require_recent_auth,
)
from dj.free2z.throttling import PASSWORD_LOGIN_THROTTLES

from .. import account_deletion

logger = logging.getLogger(__name__)

__all__ = ["AccountDeletionView", "AccountDeletionScheduleView", "AccountDeletionKeepView"]

REAUTH_DETAIL = "Sign in again to delete your account."


class AccountDeletionPreviewSerializer(serializers.Serializer):
    username = serializers.CharField()
    balance_2z = serializers.DecimalField(
        max_digits=17, decimal_places=3,
        help_text="2Z credits the account still holds; they cannot be used after deletion.",
    )
    connected_apps = serializers.IntegerField(
        help_text="Apps with live access; all of them lose it.")
    pages = serializers.IntegerField()
    grace_days = serializers.IntegerField(
        help_text="Days between the request and the purge; signing in before then keeps the account.")
    username_reserved_days = serializers.IntegerField(
        help_text="Days after the purge before anyone else may take the username.")
    deletion_cancelled_at = serializers.DateTimeField(
        allow_null=True,
        help_text="When a sign-in last kept this account during a grace period.")
    blockers = serializers.ListField(
        child=serializers.ChoiceField(choices=list(account_deletion.BLOCKERS)),
        help_text=(
            "Why the account cannot be deleted here yet. `earnings_owed`: "
            "creator earnings are owed or paid work is not yet settled; "
            "support settles them first. `app_has_users`: the account owns "
            "an SDK app with grants or purchases. `staff_account`: another "
            "admin must remove staff access first."
        ),
    )


class AccountDeletionRequestSerializer(serializers.Serializer):
    confirm_username = serializers.CharField(
        max_length=150, trim_whitespace=True,
        help_text="The signed-in account's username, typed by its holder.",
    )


_ERROR = inline_serializer(
    name="AccountDeletionError",
    fields={"code": serializers.CharField(), "detail": serializers.CharField()},
)


_SCHEDULE_RESPONSES = {
    202: inline_serializer(
        name="AccountDeletionScheduled",
        fields={
            "purge_after": serializers.DateTimeField(),
            "username_free_after": serializers.DateTimeField(),
        },
    ),
    400: OpenApiResponse(_ERROR, description=(
        "`confirmation_mismatch`: `confirm_username` is not the "
        "signed-in account's username.")),
    401: OpenApiResponse(_ERROR, description=(
        "`insufficient_user_authentication`: no sign-in within the "
        "last 5 minutes. Sign in again, then retry.")),
    409: OpenApiResponse(_ERROR, description=(
        "`earnings_owed`, `app_has_users` or `staff_account` (see the "
        "preview's `blockers`), or `inactive` (the account is already "
        "deleted or deactivated). Nothing was changed.")),
}


class AccountDeletionView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(
        operation_id="account_deletion_preview",
        summary="What deleting this account would do",
        responses={200: AccountDeletionPreviewSerializer},
    )
    def get(self, request):
        data = AccountDeletionPreviewSerializer(
            account_deletion.preview(request.user)).data
        response = Response(data)
        response["Cache-Control"] = "no-store"
        return response


class AccountDeletionScheduleView(APIView):
    """``POST /api/auth/account-deletion/schedule/``: request deletion.

    Its own path: before the grace period a POST on the preview's path
    deleted the account at once, so a new page talking to an old backend pod
    (a rollout that timed out half way) would have destroyed an account it
    had just promised 30 days to. An old backend answers this path 404, and
    a POST on the old path now answers 405: only cached pages ever sent one,
    and an honest refusal beats an alias whose answer they cannot read.
    """

    permission_classes = [IsAuthenticated]

    @extend_schema(
        operation_id="account_deletion_schedule",
        summary="Request deletion of the signed-in account",
        description=(
            "Schedules deletion after a 30-day grace period; signing in "
            "before then offers to keep the account. Replaces `POST "
            "/api/auth/account-deletion/`, which deleted at once and now "
            "answers 405 (that path is the preview, GET only)."
        ),
        request=AccountDeletionRequestSerializer,
        responses=_SCHEDULE_RESPONSES,
    )
    def post(self, request):
        return _schedule_deletion(request)


def _schedule_deletion(request):
    serializer = AccountDeletionRequestSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    require_recent_auth(request, detail=REAUTH_DETAIL)
    # Read once: a concurrent ownership event can retire the context
    # between two reads, and the locked re-check needs its epoch.
    context = current_auth_context(request)
    if context is None:
        raise RecentAuthenticationRequired(REAUTH_DETAIL)
    confirm = serializer.validated_data["confirm_username"]
    if confirm != request.user.username:
        return _mismatch()
    try:
        purge_after = account_deletion.schedule_deletion(
            request.user,
            confirm_username=confirm,
            # The epoch the recent sign-in was proved under; re-checked
            # under the row lock (see schedule_deletion).
            auth_epoch=context.account_epoch,
        )
    except account_deletion.DeletionBlocked as blocked:
        if blocked.code == account_deletion.REAUTHENTICATE:
            raise RecentAuthenticationRequired(REAUTH_DETAIL) from None
        if blocked.code == account_deletion.CONFIRMATION_MISMATCH:
            return _mismatch()
        return Response(
            {"code": blocked.code,
             "detail": "This account cannot be deleted here yet."},
            status=status.HTTP_409_CONFLICT,
        )
    # The epoch bump already ended every session server-side; this also
    # clears this browser's cookie in the same response.
    logout(request)
    return Response(
        {"purge_after": purge_after,
         "username_free_after": purge_after + account_deletion.USERNAME_RESERVATION},
        status=status.HTTP_202_ACCEPTED,
    )


class AccountDeletionKeepRequestSerializer(serializers.Serializer):
    keep_token = serializers.CharField(
        max_length=2048,
        help_text="From a sign-in's 409 `deletion_pending` answer (or the keep page's link).",
    )


class AccountDeletionKeepView(APIView):
    """``POST /api/auth/account-deletion/keep/``: "Keep my account".

    A sign-in to an account in its deletion grace period is answered with a
    keep token instead of a credential. Spending it here cancels the deletion
    (``account_deletion.keep_account``: the account is active again, app
    grants stay revoked, the cancel is recorded and notified) and THEN signs
    the holder in -- a session for a browser, a Knox token for a native app --
    recording the proof the original sign-in made. Anonymous by definition;
    the keep token is the credential, short-lived and single-use.
    """

    permission_classes = [AllowAny]
    throttle_classes = PASSWORD_LOGIN_THROTTLES

    @extend_schema(
        operation_id="account_deletion_keep",
        parameters=[OpenApiParameter(
            name=account_deletion.KEEP_COOKIE, location=OpenApiParameter.COOKIE,
            required=False, type=str,
            description=(
                "Set (HttpOnly, SameSite=Strict) by the sign-in answer that "
                "issued a browser keep token; binds that token to this "
                "browser. Without it, a browser keep token answers 400 "
                "`keep_token_invalid`. Native (Knox) keep tokens need none."),
        )],
        summary="Keep an account whose deletion is pending, and sign in",
        request=AccountDeletionKeepRequestSerializer,
        responses={
            200: inline_serializer(
                name="AccountDeletionKept",
                fields={
                    "username": serializers.CharField(),
                    "token": serializers.CharField(
                        required=False,
                        help_text="Only for a native sign-in (social, wallet): a Knox token."),
                },
            ),
            400: OpenApiResponse(_ERROR, description=(
                "`keep_token_invalid`: expired, already spent, issued to "
                "another browser, or the account is no longer waiting to be "
                "kept. Sign in again.")),
            403: OpenApiResponse(description=(
                "A browser keep (one that answers with a session) without a "
                "valid CSRF token.")),
        },
    )
    def post(self, request):
        serializer = AccountDeletionKeepRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        keep_token = serializer.validated_data["keep_token"]
        nonce = request.COOKIES.get(account_deletion.KEEP_COOKIE)
        try:
            claims = account_deletion.read_keep_token(keep_token, browser_nonce=nonce)
            if claims.get("c") == "session":
                # This answer signs a browser in, so it gets the CSRF check
                # DRF skips for anonymous callers (login CSRF); the token is
                # also bound to the browser that signed in (KEEP_COOKIE).
                _enforce_csrf(request)
            creator, claims = account_deletion.keep_account(
                keep_token, browser_nonce=nonce)
        except account_deletion.KeepTokenInvalid as invalid:
            logger.warning("account deletion keep refused: %s", invalid)
            return _forget_keep_cookie(Response(
                {"code": "keep_token_invalid",
                 "detail": "This link has expired. Sign in again to keep your account."},
                status=status.HTTP_400_BAD_REQUEST,
            ))
        epoch = creator.kt_account_epoch
        auth_time = account_deletion.keep_auth_time(claims)
        if claims.get("c") == "knox":
            from dj.apps.ktauth.credentials import issue_bearer_token

            instance, token = issue_bearer_token(creator, epoch)
            record_login(None, creator, methods=claims["m"],
                         second_factor=claims.get("f"), token=instance,
                         account_epoch=epoch, auth_time=auth_time)
            response = Response({"username": creator.username, "token": token})
            response["Cache-Control"] = "no-store"
            return response
        login(request, creator, backend="django.contrib.auth.backends.ModelBackend")
        record_login(request, creator, methods=claims["m"],
                     second_factor=claims.get("f"), account_epoch=epoch,
                     auth_time=auth_time)
        response = Response({"username": creator.username})
        response["Cache-Control"] = "no-store"
        return _forget_keep_cookie(response)


def _enforce_csrf(request):
    """DRF ``SessionAuthentication.enforce_csrf``, for an anonymous view."""
    from rest_framework.authentication import CSRFCheck
    from rest_framework.exceptions import PermissionDenied

    check = CSRFCheck(lambda _request: None)
    check.process_request(request._request)
    reason = check.process_view(request._request, None, (), {})
    if reason:
        raise PermissionDenied(f"CSRF Failed: {reason}")


def _forget_keep_cookie(response):
    response.delete_cookie(
        account_deletion.KEEP_COOKIE, path=account_deletion.KEEP_COOKIE_PATH,
        samesite="Strict")
    return response


def _mismatch():
    return Response(
        {"code": "confirmation_mismatch",
         "detail": "Type your username exactly as shown."},
        status=status.HTTP_400_BAD_REQUEST,
    )
