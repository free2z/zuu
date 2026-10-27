"""KYC intake API.

Every view here is annotated with `@extend_schema`. That is not decoration:
these are hand-rolled `APIView`s that build `Response({...})` dicts, so
drf-spectacular has nothing to introspect and, before, emitted
`customInstance<void>` for all seven operations in the generated TypeScript
client. A flow cannot be typed against `void`, which is why the SvelteKit
intake page did not exist and migrated creators had no way to complete KYC.

The annotations describe what the code already does — they are deliberately
not wired into the view bodies, so behaviour is unchanged and the existing
tests pass untouched.
"""
from django.shortcuts import get_object_or_404
from django.core.exceptions import ObjectDoesNotExist

from drf_spectacular.utils import extend_schema

from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status
from rest_framework.permissions import IsAuthenticated


from dj.apps.uploads.tasks import (
    _record_blob_for_cleanup as record_blob_for_cleanup,
)

from .models import UserProfile, W9, W8BEN, W8BENE
from .serializers import (
    ApplicationStatusChangeSerializer,
    BasicInfoSerializer,
    IdentityDocumentDeleteSerializer,
    IdentityDocumentsSerializer,
    IdentityDocumentsUploadSerializer,
    KYCErrorSerializer,
    KYCIdentityErrorSerializer,
    KYCMessageSerializer,
    TaxFormFileSerializer,
    TaxFormUploadRequestSerializer,
    TaxFormUploadResponseSerializer,
    UserProfileSignatureSerializer,
)
from .validation import (
    IDENTITY_FIELD_LABELS,
    IDENTITY_FIELD_TYPES,
    TAX_FORM_TYPES,
    UploadTypeError,
    validate_kyc_upload,
)


MAX_FILE_SIZE = 10 * 1024 * 1024
MAX_FILE_SIZE_LABEL = '10MB'


def _release_stored_file(instance, field_name):
    """Clear ``field_name`` on ``instance`` and hand its blob to the outbox.

    Storage is NEVER deleted here. ``FieldFile.delete()`` removes the
    object first and saves the row second, so a failed save -- or any later
    failure that rolls the request back -- left the row pointing at a blob
    that no longer existed. Instead the column is cleared and the key recorded
    in ``PendingUploadBlobDeletion`` inside the request's transaction (DELETE
    is wrapped by ``AtomicMiddleware``); the upload blob worker deletes the
    object only after that commits, and only if no row references it any more.
    It also never deletes a shared-bucket key outside prod, which a stage
    request on a copy of the prod database used to do inline.
    """
    name = getattr(instance, field_name).name
    setattr(instance, field_name, None)
    instance.save(update_fields=[field_name, 'updated_at'])
    if name:
        record_blob_for_cleanup(name)


class UserProfileBasicInfoView(APIView):
    """Basic KYC facts: US vs non-US, individual vs entity, and the current
    application status. The GET is the resume point for the intake flow."""

    permission_classes = [IsAuthenticated]

    @extend_schema(
        operation_id='kyc_profile_retrieve',
        responses={200: BasicInfoSerializer},
        description='Current applicant profile. Creates an empty NEW profile '
                    'on first read so a brand-new applicant gets a resumable '
                    'state rather than a 404.',
    )
    def get(self, request):
        user = request.user
        user_profile, created = UserProfile.objects.get_or_create(user=user)
        serializer = BasicInfoSerializer(user_profile)
        return Response(serializer.data)

    @extend_schema(
        operation_id='kyc_profile_update',
        request=BasicInfoSerializer,
        responses={
            200: BasicInfoSerializer,
            201: BasicInfoSerializer,
            400: KYCMessageSerializer,
        },
        description='Set the applicant type. Editable only while the '
                    'application is NEW; `application_status` is read-only and '
                    'cannot be self-advanced.',
    )
    def post(self, request):
        user = request.user
        user_profile, created = UserProfile.objects.get_or_create(user=user)

        if not user_profile.can_edit():
            return Response({
                'message': f'Your application is {user_profile.application_status}. You cannot edit at this time. Please contact support.'},
                status=status.HTTP_400_BAD_REQUEST)

        # Update the user_profile instance with the provided data
        serializer = BasicInfoSerializer(user_profile, data=request.data, partial=True)
        if serializer.is_valid():
            serializer.save()
            return Response(serializer.data, status=status.HTTP_200_OK if not created else status.HTTP_201_CREATED)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)


class TaxFormUploadView(APIView):
    """Upload the completed W-9 / W-8BEN / W-8BEN-E PDF."""

    permission_classes = [IsAuthenticated]

    @extend_schema(
        operation_id='kyc_tax_form_upload',
        request={'multipart/form-data': TaxFormUploadRequestSerializer},
        responses={
            201: TaxFormUploadResponseSerializer,
            400: KYCMessageSerializer,
        },
        description='Store the completed tax form. Which model row it lands '
                    'in (W9/W8BEN/W8BENE) follows from the profile, not from '
                    'anything the client sends. The file type is decided by '
                    'sniffing the bytes; the declared Content-Type is ignored.',
    )
    def post(self, request, format=None):
        user_profile = get_object_or_404(UserProfile, user=request.user)
        if not user_profile.can_edit():
            return Response({
                'message': f'Your application is {user_profile.application_status}. You cannot edit at this time. Please contact support.'},
                status=status.HTTP_400_BAD_REQUEST)
        file = request.FILES.get('file')
        if file is None:
            return Response({'message': 'No file was uploaded'}, status=status.HTTP_400_BAD_REQUEST)

        if file.size > MAX_FILE_SIZE:
            return Response({'message': f'File size exceeds {MAX_FILE_SIZE_LABEL} limit'}, status=status.HTTP_400_BAD_REQUEST)

        #this used to be `file.content_type == 'application/pdf'` — the
        # client-declared multipart header, which the uploader chooses freely
        # (`curl -F "file=@evil.html;type=application/pdf"`). Decide on the
        # bytes; `validate_kyc_upload` also rewrites `file.name` so the stored
        # extension — which becomes the served Content-Type — matches them.
        try:
            validate_kyc_upload(file, TAX_FORM_TYPES, label='Tax form')
        except UploadTypeError as exc:
            return Response({'message': exc.detail}, status=status.HTTP_400_BAD_REQUEST)

        if user_profile.is_us:
            instance, _ = W9.objects.get_or_create(profile=user_profile)
        elif user_profile.is_individual:
            instance, _ = W8BEN.objects.get_or_create(profile=user_profile)
        else:
            instance, _ = W8BENE.objects.get_or_create(profile=user_profile)

        instance.file = file
        instance.save()
        return Response({
            'message': 'File uploaded successfully',
            'file_url': instance.get_url()
        }, status=status.HTTP_201_CREATED)


class TaxFormDeleteView(APIView):
    """Remove the uploaded tax form so the applicant can replace it."""

    permission_classes = [IsAuthenticated]

    @extend_schema(
        operation_id='kyc_tax_form_delete',
        request=None,
        responses={204: None, 400: KYCMessageSerializer},
    )
    def delete(self, request, format=None):
        user_profile = get_object_or_404(UserProfile, user=request.user)
        if not user_profile.can_edit():
            return Response({
                'message': f'Your application is {user_profile.application_status}. You cannot edit at this time. Please contact support.'},
                status=status.HTTP_400_BAD_REQUEST)

        if user_profile.is_us:
            instance = get_object_or_404(W9, profile=user_profile)
        elif user_profile.is_individual:
            instance = get_object_or_404(W8BEN, profile=user_profile)
        else:
            instance = get_object_or_404(W8BENE, profile=user_profile)

        _release_stored_file(instance, 'file')
        return Response(status=status.HTTP_204_NO_CONTENT)


class GetTaxFormFileView(APIView):
    """Where the applicant's stored tax form lives, or null."""

    permission_classes = [IsAuthenticated]

    @extend_schema(
        operation_id='kyc_tax_form_retrieve',
        responses={200: TaxFormFileSerializer},
        description='`file` is an authenticated `/uploadz/private/...` path, '
                    'never a public URL, and is null before anything is '
                    'uploaded.',
    )
    def get(self, request, format=None):
        user_profile = get_object_or_404(UserProfile, user=request.user)

        try:
            if user_profile.is_us:
                instance = W9.objects.get(profile=user_profile)
            elif user_profile.is_individual:
                instance = W8BEN.objects.get(profile=user_profile)
            else:
                instance = W8BENE.objects.get(profile=user_profile)
            file_url = instance.get_url()
        except ObjectDoesNotExist:
            file_url = None

        return Response({'file': file_url})


class TaxFormSignatureView(APIView):
    """The typed-name electronic signature for the tax form.

    https://www.irs.gov/newsroom/details-on-using-e-signatures-for-certain-forms
    """

    permission_classes = [IsAuthenticated]

    @extend_schema(
        operation_id='kyc_signature_retrieve',
        responses={200: UserProfileSignatureSerializer},
    )
    def get(self, request, format=None):
        user_profile, created = UserProfile.objects.get_or_create(user=request.user)
        serializer = UserProfileSignatureSerializer(user_profile)
        return Response(serializer.data)

    @extend_schema(
        operation_id='kyc_signature_update',
        request=UserProfileSignatureSerializer,
        responses={200: UserProfileSignatureSerializer, 400: KYCMessageSerializer},
    )
    def post(self, request, format=None):
        user_profile, created = UserProfile.objects.get_or_create(user=request.user)
        if not user_profile.can_edit():
            return Response({
                'message': f'Your application is {user_profile.application_status}. You cannot edit at this time. Please contact support.'},
                status=status.HTTP_400_BAD_REQUEST)

        serializer = UserProfileSignatureSerializer(user_profile, data=request.data)
        if serializer.is_valid():
            serializer.save()
            return Response(serializer.data, status=status.HTTP_200_OK)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)


class IdentityDocumentsView(APIView):
    """ID front/back, an optional supporting document, and the live photo.

    All three verbs return the same full four-URL state, so a client never has
    to guess what changed.
    """

    permission_classes = [IsAuthenticated]

    @extend_schema(
        operation_id='kyc_identity_documents_retrieve',
        responses={200: IdentityDocumentsSerializer},
    )
    def get(self, request):
        # A brand-new user has no UserProfile row yet; `request.user.userprofile`
        # then raises RelatedObjectDoesNotExist -> 500. get_or_create makes the
        # read return empty URLs instead of crashing.
        profile, _ = UserProfile.objects.get_or_create(user=request.user)
        data = {
            'id_front_url': profile.get_id_url('id_front'),
            'id_back_url': profile.get_id_url('id_back'),
            'additional_document_url': profile.get_id_url('additional_document'),
            'live_photo_url': profile.get_id_url('live_photo'),
        }
        return Response(data)

    @extend_schema(
        operation_id='kyc_identity_documents_upload',
        request={'multipart/form-data': IdentityDocumentsUploadSerializer},
        responses={
            200: IdentityDocumentsSerializer,
            400: KYCIdentityErrorSerializer,
        },
        description='Upload one or more identity documents. Send only the '
                    'fields you want to replace. Every submitted file is '
                    'validated by content before any of them is stored, so a '
                    'single rejected file leaves the others untouched too.',
    )
    def post(self, request):
        profile, _ = UserProfile.objects.get_or_create(user=request.user)

        if not profile.can_edit():
            return Response({
                'message': f'Your application is {profile.application_status}. You cannot edit at this time. Please contact support.'},
                status=status.HTTP_400_BAD_REQUEST)

        # Validate EVERY submitted file before assigning ANY of them, so one
        # hostile file in a multi-field POST cannot ride along beside good
        # ones.: the old check was `uploaded_file.content_type not in
        # [...]` — the client's own claim about its own file, which is no check
        # at all. `validate_kyc_upload` sniffs the bytes and normalizes the
        # stored name.
        validated = []
        for field, allowed_types in IDENTITY_FIELD_TYPES.items():
            uploaded_file = request.FILES.get(field)
            if not uploaded_file:
                continue

            label = IDENTITY_FIELD_LABELS[field]
            if uploaded_file.size > MAX_FILE_SIZE:
                return Response(
                    {'error': f'{label} size exceeds {MAX_FILE_SIZE_LABEL} limit'},
                    status=status.HTTP_400_BAD_REQUEST)

            try:
                validate_kyc_upload(uploaded_file, allowed_types, label=label)
            except UploadTypeError as exc:
                return Response({'error': exc.detail}, status=status.HTTP_400_BAD_REQUEST)

            validated.append((field, uploaded_file))

        for field, uploaded_file in validated:
            setattr(profile, field, uploaded_file)

        # `update_fields`, not a blanket save. The applicant's browser uploads
        # one document per request, and a person who picks the ID front and the
        # ID back a second apart has two requests in flight over the same row.
        # A full `profile.save()` writes every column from whichever snapshot
        # loaded first, so the later save silently reverts the other upload —
        # and, worse, could revert `application_status` from PENDING back to
        # NEW if a submit raced an upload. Writing only the columns this request
        # actually touched makes the two requests commute.
        #
        # `updated_at` is auto_now and would be skipped otherwise, so it is
        # named explicitly to keep the timestamp behaviour identical.
        if validated:
            profile.save(update_fields=[f for f, _ in validated] + ['updated_at'])

        data = {
            'id_front_url': profile.get_id_url('id_front'),
            'id_back_url': profile.get_id_url('id_back'),
            'additional_document_url': profile.get_id_url('additional_document'),
            'live_photo_url': profile.get_id_url('live_photo'),
        }
        return Response(data, status=status.HTTP_200_OK)

    @extend_schema(
        operation_id='kyc_identity_documents_delete',
        request=IdentityDocumentDeleteSerializer,
        responses={
            200: IdentityDocumentsSerializer,
            400: KYCIdentityErrorSerializer,
        },
        description='Delete one stored document, named by `doc_type`. Returns '
                    'the remaining state so the caller can re-render without a '
                    'follow-up read.',
    )
    def delete(self, request):
        profile, _ = UserProfile.objects.get_or_create(user=request.user)
        if not profile.can_edit():
            return Response({
                'message': f'Your application is {profile.application_status}. You cannot edit at this time. Please contact support.'},
                status=status.HTTP_400_BAD_REQUEST)
        doc_type = request.data.get('doc_type')

        if doc_type not in IDENTITY_FIELD_TYPES:
            return Response({'error': 'Invalid document type.'}, status=status.HTTP_400_BAD_REQUEST)

        # Writes only this column (a whole-model save has the same
        # cross-request clobbering problem as the POST above), and the blob
        # goes through the deletion outbox after COMMIT.
        _release_stored_file(profile, doc_type)

        data = {
            'id_front_url': profile.get_id_url('id_front'),
            'id_back_url': profile.get_id_url('id_back'),
            'additional_document_url': profile.get_id_url('additional_document'),
            'live_photo_url': profile.get_id_url('live_photo'),
        }
        return Response(data, status=status.HTTP_200_OK)


class ChangeApplicationStatusView(APIView):
    """Submit the application for human review (NEW -> PENDING).

    Also runs the reverse for an APPROVED profile (APPROVED -> NEW), which is
    how an approved creator reopens their own application to correct a
    document. Every other transition — and in particular anything that reaches
    APPROVED — is a reviewer action in the admin, never a client one.
    """

    permission_classes = [IsAuthenticated]

    @extend_schema(
        operation_id='kyc_change_status',
        request=None,
        responses={
            200: ApplicationStatusChangeSerializer,
            400: KYCErrorSerializer,
        },
        description='Toggle the applicant-controlled half of the state '
                    'machine: NEW -> PENDING to submit for review, or '
                    'APPROVED -> NEW to reopen. A PENDING or REJECTED '
                    'application answers 400 — only a reviewer moves those.',
    )
    def post(self, request, *args, **kwargs):
        user_profile = get_object_or_404(UserProfile, user=request.user)

        if user_profile.application_status == 'APPROVED':
            user_profile.application_status = 'NEW'
            user_profile.save()
            return Response({'status': 'Application status changed to NEW'}, status=status.HTTP_200_OK)

        if user_profile.application_status == 'NEW':
            user_profile.application_status = 'PENDING'
            user_profile.save()
            return Response({'status': 'Application status changed to PENDING'}, status=status.HTTP_200_OK)

        # If the application is neither APPROVED nor NEW
        return Response({'error': 'Invalid application status transition'}, status=status.HTTP_400_BAD_REQUEST)
