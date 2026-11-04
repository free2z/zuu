"""The developer console's API (`/developers/apps`, spec §2) --.

A developer registers, edits, rotates and deletes their OWN apps here. There
is no privileged path: Free2Z's own apps and Corpora's go through
exactly these endpoints, and nothing an operator alone may set is writable:

* ``approved_markup_bps`` -- markup approval is manual, in the admin. A
  developer may ask for any markup up to the platform cap; the excess over
  the approval is ``pending`` and applies to nobody (spec §2).
* ``first_party``, ``frozen``, ``allow_zcash_assertion`` -- operator flags.
* turning ``child_directed`` OFF -- a developer may declare an app
  child-directed, but only staff may undo it (in the admin); every change is
  recorded in ``AudienceChange``.
* ``client_type`` -- fixed at registration. Switching a public client to
  confidential would need a secret the developer never saw issued; switching
  a confidential one to public would silently drop the secret its server
  sends. Register a second app instead.

The registration invariants themselves (redirect URI shapes, scopes, the
markup cap, the secret rule, and 's name / origin / https-metadata
policy in ``registration_policy``) live in ``F2ZApplication.clean`` and run on
every save; this module only maps their errors onto DRF's shape so the
console can show them next to the field.

The plaintext client secret exists in exactly two responses: the create of a
confidential client and a rotation. It is stored hashed and never readable
again.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework import exceptions, serializers, status
from rest_framework.parsers import JSONParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from . import ledger_projection
from .models import AiOutputReport, AppAuthorization, AudienceChange, CapPeriod, F2ZApplication
from .scopes import ALL_SCOPES, MARKUP_CAP_BPS, scope_string

#How many apps one developer account may register. Generous for a real
#developer (a web, a desktop and a server client per product), and a bound
#on what one account can make the registry carry.
MAX_APPS_PER_DEVELOPER = 25

#Mirrors the columns' own limits so an over-long value is a 400 naming the
#field, not a database error.
NAME_MAX_LENGTH = 255
#``default_spend_cap_2z`` is a PositiveIntegerField: a larger value is a
#database error (500), not a validation error, without this bound.
MAX_DEFAULT_SPEND_CAP_2Z = 2_147_483_647
URL_MAX_LENGTH = 1024


class DeveloperAppSerializer(serializers.Serializer):
    """A registration as its developer sees it."""

    id = serializers.UUIDField(read_only=True)
    client_id = serializers.CharField(read_only=True)
    client_type = serializers.ChoiceField(
        choices=[F2ZApplication.CLIENT_PUBLIC, F2ZApplication.CLIENT_CONFIDENTIAL],
        help_text="Fixed at registration: `public` (native or browser app, no "
                  "secret) or `confidential` (server-side, issued a secret).",
    )
    name = serializers.CharField(
        max_length=NAME_MAX_LENGTH,
        help_text="Shown on the consent screen. May not contain \"Free2Z\" in "
                  "any spelling or lookalike form (only Free2Z's own apps may), "
                  "nor control, bidirectional or zero-width characters.",
    )
    redirect_uris = serializers.ListField(
        child=serializers.CharField(allow_blank=True, trim_whitespace=False),
        allow_empty=False,
        help_text="Exact redirect URIs (spec §3): https, loopback http "
                  "(127.0.0.1 or [::1]), or a reverse-DNS private-use scheme. "
                  "A confidential client may register https only.",
    )
    allowed_scopes = serializers.ListField(
        child=serializers.ChoiceField(choices=list(ALL_SCOPES)),
        required=False,
        help_text="The scopes the app may request.",
    )
    allowed_origins = serializers.ListField(
        child=serializers.CharField(),
        required=False,
        help_text="https origins a browser client calls the token endpoint "
                  "from (spec §3.1), exactly as the browser sends them: "
                  "`https://host[:port]`, lowercase, no path, query or "
                  "fragment. Hosts on Free2Z's own domains are refused.",
    )
    markup_bps = serializers.IntegerField(
        min_value=0, max_value=MARKUP_CAP_BPS, required=False,
        help_text=f"The markup the app ASKS for, in basis points (0..{MARKUP_CAP_BPS}). "
                  "Applied only up to the platform's manual approval.",
    )
    approved_markup_bps = serializers.IntegerField(
        read_only=True, allow_null=True,
        help_text="Set by the platform, by hand. Null = never reviewed.",
    )
    effective_markup_bps = serializers.IntegerField(
        read_only=True, help_text="min(markup_bps, approved_markup_bps or 0).",
    )
    markup_approval = serializers.ChoiceField(
        choices=["none", "pending", "approved"], read_only=True,
    )
    default_spend_cap_2z = serializers.IntegerField(
        min_value=0, max_value=MAX_DEFAULT_SPEND_CAP_2Z, allow_null=True, required=False,
        help_text="Optional budget suggested separately to each user at first AI consent, "
                  "in whole 2Z; not a shared app quota. Null suggests prepaid balance "
                  "without an extra budget. Users may change or remove it.",
    )
    default_cap_period = serializers.ChoiceField(
        choices=CapPeriod.choices, required=False,
        help_text="The period of `default_spend_cap_2z`; `total` never resets. It also bounds "
                  "a sign-in's `f2z_spend_cap` / `f2z_spend_period` hint: the consent screen "
                  "never pre-selects more than this default allows.",
    )
    logo_url = serializers.URLField(max_length=URL_MAX_LENGTH, allow_blank=True, required=False,
                                    help_text="https only.")
    privacy_url = serializers.URLField(max_length=URL_MAX_LENGTH, allow_blank=True, required=False,
                                       help_text="https only.")
    terms_url = serializers.URLField(max_length=URL_MAX_LENGTH, allow_blank=True, required=False,
                                     help_text="https only.")
    child_directed = serializers.BooleanField(
        required=False,
        help_text="The app is directed to children or to all ages. The consent "
                  "screen then addresses the adult account holder, and access "
                  "tokens carry `child_directed` for the AI gateway. A developer "
                  "may set it; turning it off needs Free2Z staff.",
    )
    first_party = serializers.BooleanField(read_only=True)
    frozen = serializers.BooleanField(read_only=True)
    has_client_secret = serializers.BooleanField(read_only=True)
    created = serializers.DateTimeField(read_only=True)
    updated = serializers.DateTimeField(read_only=True)

    def to_representation(self, instance: F2ZApplication) -> dict:
        return {
            "id": str(instance.pk),
            "client_id": instance.client_id,
            "client_type": instance.client_type,
            "name": instance.name,
            "redirect_uris": instance.redirect_uri_list,
            "allowed_scopes": instance.allowed_scope_list,
            "allowed_origins": instance.allowed_origins.split(),
            "markup_bps": instance.markup_bps,
            "approved_markup_bps": instance.approved_markup_bps,
            "effective_markup_bps": instance.effective_markup_bps,
            "markup_approval": instance.markup_approval,
            "default_spend_cap_2z": instance.default_spend_cap_2z,
            "default_cap_period": instance.default_cap_period,
            "logo_url": instance.logo_url,
            "privacy_url": instance.privacy_url,
            "terms_url": instance.terms_url,
            "child_directed": instance.child_directed,
            "first_party": instance.first_party,
            "frozen": instance.frozen,
            "has_client_secret": bool(instance.client_secret),
            "created": serializers.DateTimeField().to_representation(instance.created),
            "updated": serializers.DateTimeField().to_representation(instance.updated),
        }


class DeveloperAppCreatedSerializer(DeveloperAppSerializer):
    client_secret = serializers.CharField(
        read_only=True, allow_null=True,
        help_text="A confidential client's secret, in plaintext, in THIS "
                  "response only. Null for a public client.",
    )


class ClientSecretSerializer(serializers.Serializer):
    client_secret = serializers.CharField(
        help_text="The new secret, in plaintext, in this response only. The "
                  "previous one stops working immediately.",
    )


def _apply(app: F2ZApplication, data: dict) -> None:
    """Copy validated console fields onto the row (never the operator's)."""
    if app.child_directed and data.get("child_directed") is False:
        raise exceptions.ValidationError({
            "child_directed": ["only Free2Z staff can turn this off; contact support"],
        })
    if "name" in data:
        app.name = data["name"]
    if "redirect_uris" in data:
        app.redirect_uris = " ".join(data["redirect_uris"])
    if "allowed_scopes" in data:
        app.allowed_scopes = scope_string(data["allowed_scopes"])
    if "allowed_origins" in data:
        app.allowed_origins = " ".join(data["allowed_origins"])
    if data.get("child_directed"):
        app.child_directed = True
    for field in (
        "markup_bps", "default_spend_cap_2z", "default_cap_period",
        "logo_url", "privacy_url", "terms_url",
    ):
        if field in data:
            setattr(app, field, data[field])


def _save(app: F2ZApplication) -> None:
    """``save()`` runs ``clean()``; its errors become a field-keyed 400."""
    try:
        app.save()
    except DjangoValidationError as exc:
        detail = exc.message_dict if hasattr(exc, "error_dict") else {"non_field_errors": exc.messages}
        raise exceptions.ValidationError(detail) from None
    # In the SAME transaction, under the row lock every caller holds: an
    # on_commit projection could land out of order between two concurrent
    # edits (a stale markup overwriting a newer one) or be lost to a crash
    # between commit and callback (codex review, ). A no-op until the
    # ledger's `ledger_app` table exists (L2).
    ledger_projection.sync_application(app)


def _refuse_whitespace(uris: list[str]) -> None:
    """Entries arrive as a list but are stored space-joined, so a URI
    carrying whitespace would silently split into two registrations."""
    bad = [uri for uri in uris if uri != uri.strip() or any(c.isspace() for c in uri)]
    if bad:
        raise exceptions.ValidationError({
            "redirect_uris": [f"{uri!r}: a redirect URI may not carry whitespace" for uri in bad],
        })


def _refuse_origin_whitespace(origins: list[str]) -> None:
    bad = [o for o in origins if not o or any(c.isspace() for c in o)]
    if bad:
        raise exceptions.ValidationError({
            "allowed_origins": [f"{o!r}: an origin may not be empty or carry whitespace" for o in bad],
        })


def _own_app(request, pk) -> F2ZApplication:
    """The requester's app, else 404 -- never 403, which would confirm the id."""
    app = F2ZApplication.objects.filter(pk=pk, user=request.user).first()
    if app is None:
        raise exceptions.NotFound("no such app")
    return app


class DeveloperAppListView(APIView):
    """The signed-in developer's registrations, and registering a new one."""

    permission_classes = [IsAuthenticated]
    parser_classes = [JSONParser]

    @extend_schema(
        operation_id="oidc_developer_apps_list",
        summary="Apps the signed-in developer registered",
        responses={200: DeveloperAppSerializer(many=True)},
    )
    def get(self, request):
        apps = F2ZApplication.objects.filter(user=request.user).order_by("-created")
        return Response(DeveloperAppSerializer(apps, many=True).data)

    @extend_schema(
        operation_id="oidc_developer_apps_create",
        summary="Register an app",
        request=DeveloperAppSerializer,
        responses={
            201: DeveloperAppCreatedSerializer,
            400: OpenApiResponse(description="A field-keyed validation error."),
        },
    )
    def post(self, request):
        serializer = DeveloperAppSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        _refuse_whitespace(data["redirect_uris"])
        _refuse_origin_whitespace(data.get("allowed_origins", []))
        with transaction.atomic():
            # Counted under a lock on the developer's own row, so two
            # concurrent registrations cannot both pass the bound.
            get_user_model()._default_manager.select_for_update().filter(
                pk=request.user.pk,
            ).first()
            if F2ZApplication.objects.filter(user=request.user).count() >= MAX_APPS_PER_DEVELOPER:
                raise exceptions.ValidationError({
                    "non_field_errors": [
                        f"a developer account may register at most {MAX_APPS_PER_DEVELOPER} apps",
                    ],
                })
            app = F2ZApplication(user=request.user, client_type=data["client_type"])
            _apply(app, data)
            secret = None
            if app.client_type == F2ZApplication.CLIENT_CONFIDENTIAL:
                secret = app.issue_client_secret()
            _save(app)
            if app.child_directed:
                AudienceChange.record(app, previous=None, by=request.user,
                                      via=AudienceChange.Via.CONSOLE)
        body = DeveloperAppSerializer(app).data
        body["client_secret"] = secret
        return Response(body, status=status.HTTP_201_CREATED)


class DeveloperAppDetailView(APIView):
    """One of the signed-in developer's registrations."""

    permission_classes = [IsAuthenticated]
    parser_classes = [JSONParser]

    @extend_schema(
        operation_id="oidc_developer_app_retrieve",
        summary="One of the developer's apps",
        responses={200: DeveloperAppSerializer, 404: OpenApiResponse(description="No such app.")},
    )
    def get(self, request, app_id):
        return Response(DeveloperAppSerializer(_own_app(request, app_id)).data)

    @extend_schema(
        operation_id="oidc_developer_app_update",
        summary="Edit an app's registration",
        description="Every field is optional. `client_type` cannot change. "
                    "Raising `markup_bps` above the approval leaves the excess "
                    "pending; users see a new markup only on re-consent.",
        request=DeveloperAppSerializer(partial=True),
        responses={
            200: DeveloperAppSerializer,
            400: OpenApiResponse(description="A field-keyed validation error."),
            404: OpenApiResponse(description="No such app."),
        },
    )
    def patch(self, request, app_id):
        with transaction.atomic():
            app = F2ZApplication.objects.select_for_update().filter(
                pk=app_id, user=request.user,
            ).first()
            if app is None:
                raise exceptions.NotFound("no such app")
            serializer = DeveloperAppSerializer(data=request.data, partial=True)
            serializer.is_valid(raise_exception=True)
            data = serializer.validated_data
            if "client_type" in data and data["client_type"] != app.client_type:
                raise exceptions.ValidationError({
                    "client_type": ["the client type is fixed at registration; register a new app"],
                })
            if "redirect_uris" in data:
                _refuse_whitespace(data["redirect_uris"])
            if "allowed_origins" in data:
                _refuse_origin_whitespace(data["allowed_origins"])
            was_child_directed = app.child_directed
            _apply(app, data)
            _save(app)
            if app.child_directed != was_child_directed:
                AudienceChange.record(app, previous=was_child_directed, by=request.user,
                                      via=AudienceChange.Via.CONSOLE)
        return Response(DeveloperAppSerializer(app).data)

    @extend_schema(
        operation_id="oidc_developer_app_destroy",
        summary="Delete an app no user has authorized",
        responses={
            204: OpenApiResponse(description="Deleted."),
            404: OpenApiResponse(description="No such app."),
            409: OpenApiResponse(description="Users have authorized this app (live or "
                                             "revoked grants): its grants and the 2Z "
                                             "credits recorded against it must stay "
                                             "attributable, so it cannot be deleted "
                                             "(`app_has_authorizations`). Or users "
                                             "reported its AI output, and reports are "
                                             "kept for review (`app_has_reports`)."),
        },
    )
    def delete(self, request, app_id):
        with transaction.atomic():
            app = F2ZApplication.objects.select_for_update().filter(
                pk=app_id, user=request.user,
            ).first()
            if app is None:
                raise exceptions.NotFound("no such app")
            # Any grant, live or revoked, means tokens were minted and the
            # ledger may hold usage priced against this app's id. Deleting
            # would cascade the grants away and orphan that history.
            if AppAuthorization.objects.filter(application=app).exists():
                return Response(
                    {
                        "code": "app_has_authorizations",
                        "detail": "users have authorized this app, so it cannot be "
                                  "deleted; contact support to retire it",
                    },
                    status=status.HTTP_409_CONFLICT,
                )
            # A grant is gone once its user deletes their account, but a
            # report they filed stays for moderation (AiOutputReport's PROTECT):
            # refuse here rather than 500 on the ProtectedError.
            if AiOutputReport.objects.filter(application=app).exists():
                return Response(
                    {
                        "code": "app_has_reports",
                        "detail": "users have reported AI output from this app, and "
                                  "those reports are kept for review, so it cannot be "
                                  "deleted; contact support to retire it",
                    },
                    status=status.HTTP_409_CONFLICT,
                )
            app.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class DeveloperAppRotateSecretView(APIView):
    """Issue a new secret for a confidential client; the old one dies now."""

    permission_classes = [IsAuthenticated]
    parser_classes = [JSONParser]

    @extend_schema(
        operation_id="oidc_developer_app_rotate_secret",
        summary="Rotate a confidential client's secret",
        request=None,
        responses={
            200: ClientSecretSerializer,
            400: OpenApiResponse(description="A public client has no secret."),
            404: OpenApiResponse(description="No such app."),
        },
    )
    def post(self, request, app_id):
        with transaction.atomic():
            app = F2ZApplication.objects.select_for_update().filter(
                pk=app_id, user=request.user,
            ).first()
            if app is None:
                raise exceptions.NotFound("no such app")
            if app.client_type != F2ZApplication.CLIENT_CONFIDENTIAL:
                raise exceptions.ValidationError({
                    "client_type": ["a public client is issued no secret"],
                })
            secret = app.issue_client_secret()
            _save(app)
        return Response({"client_secret": secret})
