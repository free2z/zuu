"""Serializers for the KYC intake API.

Most of these exist for one reason: **to describe the wire format** so
drf-spectacular can emit a real schema for `f2z.yaml` and orval can generate a
typed client. The seven KYC views are hand-rolled `APIView`s that read
`request.FILES` / `request.data` and build `Response({...})` dicts directly, so
until  every KYC operation in the generated TypeScript client was
`customInstance<void>` — nothing on the client could be typed against it, which
is exactly why the SvelteKit intake flow could not be written.

These serializers therefore *mirror* what each view already returns. They are
not wired into the view bodies (that would be a behaviour change); they are
referenced from `@extend_schema` so the contract is published. Where a view has
a genuinely dict-shaped response with no model behind it, the serializer is a
plain `Serializer` with the exact keys the view sends.
"""
from rest_framework import serializers

from .models import UserProfile
from .validation import IDENTITY_FIELD_LABELS


class BasicInfoSerializer(serializers.ModelSerializer):
    class Meta:
        model = UserProfile
        fields = [
            'id', 'is_us', 'is_individual', 'application_status',
            'rejection_reason',
        ]
        # application_status must never be client-writable: it's the
        # identity-verification gate and is only advanced server-side via
        # ChangeApplicationStatusView / admin. Leaving it writable let a NEW
        # user POST {"application_status": "APPROVED"} and self-approve.
        #
        # rejection_reason is written by a human reviewer in the admin. It is
        # surfaced here so the applicant can be told *why* they were rejected
        # instead of just that they were.
        read_only_fields = ['application_status', 'rejection_reason']


class UserProfileSignatureSerializer(serializers.ModelSerializer):
    class Meta:
        model = UserProfile
        fields = ['tax_form_signature']

    def update(self, instance, validated_data):
        instance.tax_form_signature = validated_data.get('tax_form_signature', instance.tax_form_signature)
        instance.save()
        return instance


# ---------------------------------------------------------------------------
# Schema-only serializers
#
# Each one matches, key for key, a `Response({...})` literal already in
# views.py. If you change a view's payload, change the matching serializer in
# the same commit — CI regenerates f2z.yaml from these and fails on drift, but
# it cannot tell you that the *description* stopped matching the code.
# ---------------------------------------------------------------------------

class KYCMessageSerializer(serializers.Serializer):
    """`{"message":...}` — the shape of every `can_edit()` rejection."""

    message = serializers.CharField()


class KYCErrorSerializer(serializers.Serializer):
    """`{"error":...}` — used by the identity-document and status views."""

    error = serializers.CharField()


class KYCIdentityErrorSerializer(serializers.Serializer):
    """The 400 body of `/api/kyc/identity-documents`.

    Genuinely two shapes: a rejected *file* answers `{"error":...}` while the
    "your application is no longer editable" guard answers `{"message":...}`.
    Both keys are declared optional rather than papered over, because a client
    that only reads `error` silently shows nothing when an APPROVED user tries
    to re-upload — which is the more confusing failure.
    """

    error = serializers.CharField(required=False)
    message = serializers.CharField(required=False)


class TaxFormUploadRequestSerializer(serializers.Serializer):
    """multipart/form-data body of `POST /api/kyc/upload-tax-form`.

    The declared content type of this part is *not* trusted; the bytes are
    sniffed by `validation.validate_kyc_upload`. Documenting the field as a
    file says "send a file here", nothing more.
    """

    file = serializers.FileField(
        help_text='Completed tax form. PDF only; validated by content, not by '
                  'the Content-Type the client declares.',
    )


class TaxFormUploadResponseSerializer(serializers.Serializer):
    message = serializers.CharField()
    file_url = serializers.CharField(
        allow_null=True,
        help_text='Authenticated `/uploadz/private/...` path. Never public.',
    )


class TaxFormFileSerializer(serializers.Serializer):
    """`GET /api/kyc/get-tax-form-file` — null when nothing is uploaded yet."""

    file = serializers.CharField(allow_null=True)


class IdentityDocumentsSerializer(serializers.Serializer):
    """The four identity-document URLs, null where nothing is stored.

    Returned by GET, POST and DELETE on `/api/kyc/identity-documents` alike, so
    a client always has the full current state after any operation.
    """

    id_front_url = serializers.CharField(allow_null=True)
    id_back_url = serializers.CharField(allow_null=True)
    additional_document_url = serializers.CharField(allow_null=True)
    live_photo_url = serializers.CharField(allow_null=True)


class IdentityDocumentsUploadSerializer(serializers.Serializer):
    """multipart body of `POST /api/kyc/identity-documents`.

    Every field is optional — the view uploads whichever parts are present —
    but each submitted file is validated *before any* of them is assigned, so a
    single hostile file cannot ride along beside good ones.
    """

    id_front = serializers.ImageField(required=False)
    id_back = serializers.ImageField(required=False)
    additional_document = serializers.FileField(required=False)
    live_photo = serializers.ImageField(required=False)


class IdentityDocumentDeleteSerializer(serializers.Serializer):
    """`DELETE /api/kyc/identity-documents` body."""

    doc_type = serializers.ChoiceField(choices=sorted(IDENTITY_FIELD_LABELS))


class ApplicationStatusChangeSerializer(serializers.Serializer):
    """`{"status":...}` from `POST /api/kyc/change-status`."""

    status = serializers.CharField()
