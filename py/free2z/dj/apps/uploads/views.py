import json
import logging
import re
from urllib.parse import unquote, unquote_to_bytes, quote
from django.db.models import Q
from django.http import HttpRequest
from django.http import HttpResponse, JsonResponse
from django.core.files.uploadedfile import InMemoryUploadedFile
from django.core.exceptions import MultipleObjectsReturned
from django.views.decorators.http import require_POST
from django.contrib.auth.decorators import login_required
from drf_spectacular.utils import extend_schema, extend_schema_view
from rest_framework import serializers, viewsets, pagination, filters, status
from rest_framework.exceptions import APIException, ValidationError
from rest_framework.permissions import IsAuthenticated
from django_filters.rest_framework import DjangoFilterBackend

from .image_utils import create_thumbnail
from .limits import max_upload_bytes_for
from .models import (
    EXIF_TYPES, GenericFile, ImageVariant, Webp,
    remove_exif_data,
)
from .serializers import FeaturedImageSerializer, GenericFileSerializer
from .filters import GenericFileFilter
from .validation import UploadTypeError, validate_upload
from dj.util.middleware import run_after_request_transaction

logger = logging.getLogger(__name__)


_HLS_PREFIX = "/uploadz/public/hls/"
# A short positive lifetime lets Cloud CDN collapse repeated requests for the
# same VOD object without making an access transition effectively permanent.
# Six-second HLS segments therefore share an origin authorization result for
# at most ten segment durations; private/members responses remain no-store.
_HLS_PUBLIC_MAX_AGE_SECONDS = 60
_HLS_OUTPUT_RE = re.compile(
    r"(?:"
    r"(?:master|index|iframes)(?:-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)?\.m3u8"
    r"|init(?:-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)?\.mp4"
    r"|seg-[0-9]+(?:-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)?\.(?:ts|m4s)"
    r")"
)

# Sort of reverted to traditional Django but maybe DRF it later?
# https://docs.djangoproject.com/en/4.1/ref/request-response/


def _bad_request(detail):
    """
    A rejection the uploader can show the user. Kept as a JSON body with a
    plain-text-compatible `detail` so a client that only reads the status code
    is unaffected.
    """
    return JsonResponse({'detail': detail}, status=400)


def try_strip_metadata(file, mime_type=None):
    """
    Strip EXIF from jpeg/png. `mime_type` is the *sniffed* type from
    `validate_upload` — before  this keyed off the client-supplied
    `file.content_type`, so a lie about the type also skipped the strip.
    """
    if mime_type is None:
        mime_type = file.content_type
    if mime_type in EXIF_TYPES:
        try:
            processed_file = remove_exif_data(file)
            if processed_file:
                # Convert BytesIO object to InMemoryUploadedFile
                file = InMemoryUploadedFile(
                    file=processed_file,
                    field_name='file',
                    name=file.name,
                    content_type=mime_type,
                    size=processed_file.getbuffer().nbytes,
                    charset=None
                )
        except Exception as e:
            # Log or print the exception for debugging
            print(f"Error processing file: {e}")
    return file


def _original_uri(request):
    """
    Still-encoded path of the URI nginx is asking us to authorize, with
    the query string and fragment removed.

    Every delimiter decision — `?`, `#`, and the `/` that separates path
    segments — has to be made here, on the encoded string. Decoding first
    promotes an encoded `%3F`/`%23`/`%2F` inside a stored name to a real
    delimiter, which either truncates the name  or re-segments the
    path under an authorization check (see uploads_auth_private).

    A missing header yields "" instead of a TypeError out of unquote(None).
    """
    uri = request.META.get('HTTP_X_ORIGINAL_URI') or ''
    return uri.split('?')[0].split('#')[0]


def _original_path(request):
    """
    Percent-decoded path of the URI nginx is asking us to authorize.
    Only for lookups of a whole stored name; anything that splits on `/`
    must use _original_uri and decode each segment itself.
    """
    return unquote(_original_uri(request))


def _get_generic_file(name):
    """
    Auth for the thumbnail is controlled by the access of the parent

    `GenericFile.file` is intentionally not unique (see the model's own
    "what about unique?" note), so two rows can share a stored name -- a
    stale re-upload, a race, or a legacy row from before some earlier
    de-dup pass. `.get(file=name)` then raises `MultipleObjectsReturned`
    instead of returning either row, and every caller here is an nginx
    `auth_request` subrequest: an uncaught exception becomes a 500 that
    nginx then serves to *every* client requesting that URL, forever,
    until someone notices ( -- one object 500ing deterministically
    for weeks). `_hls_generic_file` already treats an ambiguous lookup
    the same as a missing one; this does the same.

    `MultipleObjectsReturned` returns None immediately rather than
    falling through to the next table, unlike `DoesNotExist`. An
    adversarial-review catch (codex, on this PR): folding both into one
    `except` clause let an ambiguous `GenericFile` name fall through to a
    *different* table's row for the same string -- e.g. two private
    `GenericFile`s named `owner/shared.webp` masking an unrelated public
    `Webp` stored under that same name, which would then authorize
    anonymous access nothing about the ambiguous rows justified. Ambiguity
    on any one table must deny outright, not demote to "keep looking".
    """
    try:
        return GenericFile.objects.select_related('owner').get(file=name)
    except GenericFile.DoesNotExist:
        pass
    except MultipleObjectsReturned:
        return None
    try:
        return Webp.objects.select_related('parent__owner').get(
            file=name).parent
    except Webp.DoesNotExist:
        pass
    except MultipleObjectsReturned:
        return None
    try:
        return ImageVariant.objects.select_related(
            'parent__owner').get(file=name).parent
    except (ImageVariant.DoesNotExist, MultipleObjectsReturned):
        return None


def _public_access_ok(gfile):
    """Is this blob still servable on the anonymous `public` tier?

    `access == "public"` is necessary and, since, no longer sufficient.
    Deactivating a creator takes their zPages down, but a featured image, a
    cover, an `ImageVariant`/`Webp` derivative, a podcast enclosure and an HLS
    source all live behind stable `/uploadz/public/...` URLs that were shared
    and indexed long before the ban. Those URLs bypass Django's querysets
    entirely -- nginx asks this view yes/no and then serves the bytes itself --
    so this is the ONLY place the creator's state can be checked for them.

    `owner` is non-nullable on `GenericFile`, so there is no orphan case to
    fall through. Every `_get_generic_file` / `_hls_generic_file` lookup
    `select_related`s the owner, so this costs a JOIN rather than a second
    round trip on an auth subrequest that runs once per image and once per HLS
    segment.

    **This is the origin boundary, not the last one.** `k8s/free2z/nginx.conf`
    stamps `s-maxage=3600` on `/uploadz/public/...`, and Cloud CDN serves a
    fresh cached object WITHOUT issuing this auth subrequest at all. So a blob
    that was fetched once before the ban keeps being served from the edge for
    up to an hour while the origin returns 401 to every direct test.

    Corrected in: this used to say "a day through the alternate route",
    reading the `max-age=86400` on `/uploadz/...` as an edge TTL. It is not
    one. That route also carries `Vary: Cookie`, and Cloud CDN refuses to
    cache any response whose `Vary` is not one of a fixed supported list
    (`Cookie` is not on it), so the alternate route is not in the edge cache
    at all. Do not remove that `Vary` without re-reading this: dropping it
    turns the 86400 into a real 24h edge TTL and a 24h authorization-bypass
    window on any later access change. that route's policy is also
    `private` on every tier, so `Vary` is no longer the only thing standing
    between paid media and a shared cache -- but it is still what decides
    whether Cloud CDN stores the object.

    Taking bytes down for real therefore has two steps, and only the first one
    is code:

      1. deactivate the creator (this check), and
      2. invalidate the CDN (`bin/invalidate-hls-cdn.sh`, or
         `gcloud compute url-maps invalidate-cdn-cache`).

    Step 2 is deliberately NOT wired into `ban_and_soft_delete()`: it is a
    credentialed, slow, failure-prone GCP call, and a moderation action that
    can fail because a cloud API is having a bad minute is worse than one that
    is honestly documented as two steps. Recorded in / as a moderation
    runbook item rather than left implicit -- an operator who reads "401 from
    the origin" as "the file is gone" is exactly who this paragraph is for.
    """
    if gfile.access != "public" or not gfile.owner.is_active:
        return False

    # A GenericFile's access level alone cannot make a draft's featured image
    # public. If a file is attached to pages, at least one page must be
    # visible under the canonical published-and-active rule. Standalone
    # public uploads (avatars, covers and other media) retain their behavior.
    from dj.apps.g12f.models import zPage
    featured_pages = zPage.objects.filter(featured_image_id=gfile.pk)
    if not featured_pages.exists():
        return True
    if zPage.objects.published_and_active().filter(
        featured_image_id=gfile.pk,
    ).exists():
        return True
    # One canonical asset, many references: the API lets a creator point a
    # draft's `featured_image` at ANY public file they own, including the one
    # their public profile already renders as its avatar or banner. Denying
    # it here would break the avatar on every page that shows it while
    # hiding nothing -- the same bytes are already public on the profile.
    from dj.apps.g12f.models import Creator
    return Creator.objects.filter(
        Q(avatar_image_id=gfile.pk) | Q(banner_image_id=gfile.pk),
        pk=gfile.owner_id,
        is_active=True,
    ).exists()


def _featured_image_access_ok(gfile, user):
    """Allow a creator to preview their unpublished page image.

    This is used only on routes whose response cache is private/no-store.
    Public page visibility remains controlled by `_public_access_ok`.
    """
    if not user.is_authenticated or not user.is_active:
        return False
    from dj.apps.g12f.models import zPage

    pages = zPage.objects.filter(
        featured_image_id=gfile.pk,
        creator__is_active=True,
    )
    return (
        gfile.owner_id == user.pk
        and pages.filter(creator_id=user.pk).exists()
    )


def _members_access_ok(gfile, user):
    """Is this blob still servable on the paid `members` tier?

    The exact counterpart of `_public_access_ok`, and it exists for the same
    reason: `access == "members"` plus `has_fan()` was necessary and not
    sufficient. `has_fan()` answers "is there an unexpired Subscription row",
    which stays true after the creator is deactivated -- so a subscriber-only
    zPage correctly 404s while the subscriber-only VIDEO on it kept streaming
    ( item 4, measured: both `/uploads/auth` and
    `/uploads/auth-public-hls` answered 200 for a deactivated owner's members
    blob).

    Deliberately NOT folded into `Creator.has_fan()`: that method answers a
    billing question -- the renewal worker and the subscribe flow both ask it
    about people they may still charge -- and overloading it with a
    visibility rule would silently change money behaviour to fix a read path.
    """
    return (
        gfile.access == "members"
        and gfile.owner.is_active
        and gfile.owner.has_fan(user)
    )


def _decode_hls_segment(raw_segment):
    """Decode one encoded HLS path segment without changing its shape."""
    if not raw_segment or "\\" in raw_segment:
        return None

    for index, character in enumerate(raw_segment):
        if character == "%":
            escape = raw_segment[index + 1:index + 3]
            if len(escape) != 2 or not re.fullmatch(r"[0-9A-Fa-f]{2}", escape):
                return None

    try:
        segment = unquote_to_bytes(raw_segment).decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        return None

    if (
        not segment
        or "/" in segment
        or "\\" in segment
        or segment in {".", ".."}
        or any(ord(character) < 0x20 or ord(character) == 0x7f
               for character in segment)
    ):
        return None
    # Percent-hex text is literal after this one decode: raw path structure
    # was split first, exact lookup selects the row, and re-quoting the auth
    # values before nginx/GCS sees them prevents any second decode from adding
    # structure.
    return segment


def _parse_hls_identity(request):
    """
    Return ``(username, extensionless_filename)`` for one VOD HLS object.

    The request header is deliberately parsed while it is still encoded. The
    first two structural path separators identify the owner and the MP4
    stem; decoding before splitting would let an encoded slash change which
    object is authorized. The third segment is an nginx-vod output name and
    is validated independently, never used for the database lookup.
    """
    uri = _original_uri(request)
    if not uri.startswith(_HLS_PREFIX):
        return None

    segments = uri[len(_HLS_PREFIX):].split("/")
    if len(segments) != 3:
        return None

    username = _decode_hls_segment(segments[0])
    filename = _decode_hls_segment(segments[1])
    output = _decode_hls_segment(segments[2])
    if not username or not filename or not output:
        return None
    if not _HLS_OUTPUT_RE.fullmatch(output):
        return None

    return username, filename


def _hls_generic_file(username, filename):
    """Resolve one unambiguous parent MP4, never a VOD output path."""
    try:
        return GenericFile.objects.select_related("owner").get(
            file=f"{username}/{filename}.mp4"
        )
    except (GenericFile.DoesNotExist, MultipleObjectsReturned):
        return None


def uploads_auth_public_hls(request: HttpRequest):
    """
    Authorize every nginx-vod HLS request against its parent MP4.

    The response headers are consumed by nginx's ``auth_request_set``. They
    contain values derived from the row just resolved, not from the raw VOD
    output request, so the subsequent GCS request cannot change the media
    identity after this check.
    """
    identity = _parse_hls_identity(request)
    if identity is None:
        return HttpResponse("", status=401)

    username, filename = identity
    gfile = _hls_generic_file(username, filename)
    if not gfile:
        return HttpResponse("", status=401)

    allowed = _public_access_ok(gfile)
    if not allowed and request.user.is_authenticated:
        allowed = (
            gfile.owner == request.user
            or _members_access_ok(gfile, request.user)
            or request.user.is_superuser
        )
    if not allowed:
        return HttpResponse("", status=401)

    response = HttpResponse("OK")
    # Quote trusted DB values before placing them in nginx-generated URLs and
    # query arguments. The auth result, rather than the request captures,
    # supplies both the VOD URL and the GCS object identity.
    response["X-HLS-Username"] = quote(username, safe="")
    response["X-HLS-Filename"] = quote(filename, safe="")
    # `_public_access_ok`, not a bare `access == "public"`, on this branch too
    #. Reaching here does not imply the public tier allowed it: the
    # owner/members/superuser fallback above can authorize a request for a
    # deactivated creator's `public` blob, and stamping a shared-cacheable
    # `X-HLS-Cache-Control` on that answer would push a taken-down object into
    # the CDN for everybody.
    if _public_access_ok(gfile):
        # Public HLS may be stored by shared caches, but a response can remain
        # fresh for only this bounded window after an access transition.
        response["X-HLS-Cache-Control"] = (
            f"public, max-age={_HLS_PUBLIC_MAX_AGE_SECONDS}, must-revalidate"
        )
    else:
        response["X-HLS-Cache-Control"] = "private, no-store"
        response["X-HLS-Vary"] = "Cookie"
    return response


def uploads_auth_public(request):
    """
    Make sure file is public
    """
    # print("uploads_auth_public")
    uri = _original_path(request)
    # print("uploads_auth_public", uri)
    name = uri.replace("/uploadz/public/", "")
    # print("uploads_auth_public", name)

    # TODO: this is all a bit fragile and stringy
    gfile = _get_generic_file(name)
    if not gfile:
        return HttpResponse("", status=401)

    if _public_access_ok(gfile):
        response = HttpResponse("OK")
        response["X-Upload-Cache-Control"] = (
            "public, max-age=300, s-maxage=3600, proxy-revalidate"
        )
        return response
    if _featured_image_access_ok(gfile, request.user):
        response = HttpResponse("OK")
        response["X-Upload-Cache-Control"] = "private, no-store"
        return response
    return HttpResponse("", status=401)


def uploads_auth_private(request):
    """
    This is for the KYC stuff!!
    """
    if not request.user.is_authenticated:
        return HttpResponse("", status=401)
    if request.user.is_superuser:
        return HttpResponse("OK")
    if not hasattr(request.user, 'userprofile'):
        return HttpResponse("", status=401)

    # Split the profile id off the ENCODED path, then decode just that
    # segment: `<my-uid>%2F..%2F<their-uid>/doc.pdf` decodes to a path
    # whose first segment looks like mine, and this check guards KYC
    # documents. Same bug class as, higher stakes.
    uri = _original_uri(request)
    path = uri.replace("/uploadz/private/", "")
    uid = unquote(path.split("/")[0])
    if uid != str(request.user.userprofile.id):
        return HttpResponse("", status=401)
    return HttpResponse("OK")


def uploads_auth(request):
    """
    Make sure the requester is allowed to get the file.

    : this gate serves the general `/uploadz/...` route, which used to
    stamp an unconditional `Cache-Control: public, max-age=86400` in nginx --
    so members-only blobs were publicly cacheable for a day and revocation
    did not take. Like the HLS route, the cache policy is selected
    HERE from the resolved GenericFile and carried back to nginx through
    `auth_request_set` headers. Origin-boundary caveat (see
    `_public_access_ok`): Cloud CDN can serve a previously fetched object
    without issuing this subrequest at all, so taking bytes down still needs
    a CDN invalidation on top of a 401 here.
    """
    uri = _original_path(request)

    # TODO: can get rid of thumbnails path later
    name = uri.replace("/uploadz/thumbnails/", "")
    name = name.replace("/uploadz/", "")

    gfile = _get_generic_file(name)
    if not gfile:
        # Every denial below deliberately sets NO cache header: nginx's
        # `auth_request_set` only defines its variable from the headers an
        # authorized response carries, so an empty value makes `add_header`
        # emit nothing and a denied request cannot inherit any policy.
        return HttpResponse("", status=401)

    if _public_access_ok(gfile):
        response = HttpResponse("OK")
        # Anonymous-public content keeps today's 24h TTL, as `private`
        #. This is the LEGACY alias -- `/uploadz/<name>`, the URL a
        # row keeps after an access-level change -- so the same path serves
        # public, members and owner-only bytes depending on who is asking.
        # A route whose response body is chosen per requester is by
        # definition not shared-cacheable, whatever the tier of any one
        # answer, and `public` there means a shared proxy may store an
        # anonymous variant and keep serving it for a day after the row
        # becomes members/private or the creator is deactivated -- with
        # neither nginx nor this view ever running again.
        #
        # `Vary: Cookie` (an unconditional literal in nginx) is the second
        # layer, not the only one: it keeps Cloud CDN from caching this route
        # at all, because the CDN declines any response whose `Vary` is
        # outside a fixed supported list. But `Vary` is not a promise -- a
        # compliant shared cache may legitimately store a no-cookie variant,
        # and the CDN's own conditions are documented as subject to change.
        # `private` is what actually states the intent; `Vary` is what makes
        # the current edge behave. Neither is redundant.
        #
        # Costs nothing measurable: with the `Vary` in place this route was
        # never in the edge cache, and `private` still lets the browser hold
        # it for the full 86400s. The canonical public URL for genuinely
        # public media is `/uploadz/public/...`, which keeps its own
        # `public, max-age=300, s-maxage=3600` policy and is unaffected.
        response["X-Upload-Cache-Control"] = "private, max-age=86400"
        return response

    # If it's not public then the requestor must be authenticated
    if not request.user.is_authenticated:
        return HttpResponse("", status=401)

    # The superuser check moved below the file resolution so superuser access
    # also gets the private policy -- it is never the anonymous-public tier,
    # and like the HLS route a nonexistent parent must not authorize.
    if (
        request.user.is_superuser
        or gfile.owner == request.user
        or _featured_image_access_ok(gfile, request.user)
        or _members_access_ok(gfile, request.user)
    ):
        response = HttpResponse("OK")
        response["X-Upload-Cache-Control"] = "private, no-store"
        return response

    return HttpResponse("", status=401)


@login_required
@require_POST
def uploads_handle(request):
    try:
        metadata_list = json.loads(request.POST.get('body'))
    except Exception:
        return _bad_request("Bad Request")

    serializer = GenericFileSerializer(
        data=metadata_list,
        many=True,
        context={'request': request}
    )
    if not serializer.is_valid():
        return _bad_request("Bad Request")

    files = request.FILES.getlist('files')
    if len(serializer.validated_data) != len(files):
        return _bad_request("Bad Request")

    # Validate every file BEFORE saving any of them: a batch is all-or-nothing
    # so one hostile file cannot smuggle itself in beside good ones.
    sniffed_types = []
    for f in files:
        try:
            sniffed_types.append(validate_upload(f))
        except UploadTypeError as exc:
            return _bad_request(f'"{f.name}": {exc.detail}')

    for i, data in enumerate(serializer.validated_data):
        f = files[i]
        mime_type = sniffed_types[i]
        data['file'] = try_strip_metadata(f, mime_type)
        # The sniffed type, never the browser-supplied `f.content_type`.
        data['mime_type'] = mime_type

    # Stored objects outlive a rolled-back row. Each file is written
    # to storage and then INSERTed, so if file 3 of 5 fails (a storage 503, a
    # later raise) the request rolls back rows 1-2 while their objects stay in
    # the bucket with nothing pointing at them. Once the request transaction
    # has ended, delete the object of every row this request created that did
    # not survive. Only rows that were actually INSERTed are tracked, so a
    # name is only ever one this request stored. Known residue: an object
    # whose own INSERT fails right after its storage write is not reaped here
    # (the pre- behaviour for that case too).
    #
    # Created through the serializer, one child at a time, rather than a new
    # `GenericFile(...)` call: the construction-site registry in
    # `test_access_creation_paths.py` audits exactly those.
    created = []

    def reap_orphaned_objects():
        for instance in created:
            if GenericFile.objects.filter(pk=instance.pk).exists():
                continue
            try:
                instance.file.storage.delete(instance.file.name)
            except Exception:
                logger.exception(
                    "could not delete orphaned upload %s", instance.file.name)

    run_after_request_transaction(reap_orphaned_objects)
    for attrs in serializer.validated_data:
        created.append(
            serializer.child.create({**attrs, "owner": request.user}))
    instances = created
    # Return the created records (like single_public_upload_handle does).
    # The uploader needs the server-side `url` to offer copy-link /
    # open-in-new-tab / preview right after an upload; it used to
    # get a bare 201 with no body and had to guess the public path.
    return JsonResponse(
        GenericFileSerializer(instances, many=True).data,
        status=201,
        safe=False,
    )


def upload_limit(request):
    """
    nginx's `auth_request` subrequest for `/uploads*`: 204 to let the body
    through, 403 to refuse it before a byte is proxied, 401 for an anonymous
    caller.

    The tier table lives in `limits.py`, not here, because it is also what
    `GET /api/uploads/limits/` publishes to clients — nginx's `@deny_upload`
    answers a bodiless 403 that overwrites whatever this view returned, so a
    client can never learn the number from a rejection.

    NOT `@login_required`: its 302 to LOGIN_URL is a status
    auth_request does not understand, so nginx turned every anonymous upload
    into a 500 (`auth request unexpected status: 302`). auth_request only
    honours 2xx, 401 and 403.
    """
    if not request.user.is_authenticated:
        return HttpResponse(status=401)
    limit = max_upload_bytes_for(request.user)
    cl = (request.headers.get("X-Original-Content-Length") or "").strip()

    if not cl.isdigit() or int(cl) > limit:
        return HttpResponse(status=403)
    return HttpResponse(status=204)


@login_required
@require_POST
def single_public_upload_handle(request):
    serializer = GenericFileSerializer(
        data=request.POST,
        context={'request': request}
    )
    if not serializer.is_valid():
        return _bad_request("Bad Request")

    file = request.FILES.get('file')
    if not file:
        return _bad_request("Bad Request")

    try:
        mime_type = validate_upload(file)
    except UploadTypeError as exc:
        return _bad_request(exc.detail)

    file = try_strip_metadata(file, mime_type)
    serializer.validated_data['file'] = file
    # The sniffed type, never the browser-supplied `file.content_type`.
    serializer.validated_data['mime_type'] = mime_type
    instance = serializer.save(owner=request.user)
    if mime_type in ['image/jpeg', 'image/png']:
        create_thumbnail(instance)
    return JsonResponse(GenericFileSerializer(instance).data, status=201)


class UploadInUseSerializer(serializers.Serializer):
    """
    The body of the 409 below. Declared so a generated client can SEE the
    actionable failure instead of an untyped error — drf-spectacular cannot
    infer a response from an exception raised inside `perform_destroy`, so
    regenerating the spec would otherwise stay green while documenting only
    the 204 (codex review of, finding 3).
    """
    detail = serializers.CharField(
        help_text='Why the file cannot be deleted yet, and what to remove '
                  'first.',
    )


# The reasoning is a COMMENT, not a docstring: drf-spectacular publishes a
# serializer's docstring as the schema component description, and internal
# class names do not belong in a generated client.
#
# Declared for the same reason as `UploadInUseSerializer` above:
# drf-spectacular cannot infer a response body from an exception raised
# inside a view method, so without this the spec says "No response body" and
# orval types the error `void`. A refusal a client can only see as `void` is
# indistinguishable from "upload is broken", and the redirect it carries is
# the entire value of this one.
class UploadCreateUnsupportedSerializer(serializers.Serializer):
    """Why `POST /api/myuploads/` refused, and where to upload instead."""
    file = serializers.ListField(
        child=serializers.CharField(),
        help_text='Why this route cannot create an upload, and which endpoint '
                  'to upload through instead.',
    )


class Conflict(APIException):
    """409 — the request is fine, the resource's current state forbids it."""
    status_code = status.HTTP_409_CONFLICT
    default_detail = 'This file is in use.'
    default_code = 'conflict'


class TwelvePagination(pagination.PageNumberPagination):
    page_size = 12


@extend_schema_view(
    destroy=extend_schema(
        responses={
            204: None,
            409: UploadInUseSerializer,
        },
        description=(
            'Delete one of the caller\'s uploads.\n\n'
            '409 when the file illustrates a story page: `storytime.Page.'
            'image` is a CASCADE reference, so deleting the file would delete '
            'the page with it. `detail` says what to remove first. Other '
            'references (zPage cover/enclosure, creator avatar/banner, Dyte '
            'recording) are SET_NULL and do NOT block deletion — they are '
            'cleared, and the referring object survives without them.'
        ),
    ),
    create=extend_schema(
        responses={400: UploadCreateUnsupportedSerializer},
        description=(
            'Always 400 — creation is disabled on this route, whatever the '
            'body. It has no way to receive a file (the serializer has no '
            '`file` field), so the only row it could ever create is a fileless '
            'orphan: no bytes, no `mime_type`, a `url` of `/uploadz/public/`.\n'
            '\n'
            'Upload through `POST /uploads/handle` (batch) or '
            '`POST /uploads/single-public` (one file). Those sniff the bytes '
            'to decide the type, strip EXIF, and sit behind the nginx '
            'size authorization — none of which a generic create could do. '
            'This route is for listing, editing (`title`, `description`, '
            '`access`) and deleting what they created.'
        ),
    ),
)
class MyUploadsViewSet(viewsets.ModelViewSet):
    serializer_class = FeaturedImageSerializer
    # "My" uploads: every action is scoped to request.user.
    permission_classes = [IsAuthenticated]
    pagination_class = TwelvePagination
    filter_backends = [
        filters.SearchFilter,
        filters.OrderingFilter,
        DjangoFilterBackend,
    ]
    search_fields = ['title', 'file', 'description', 'mime_type']
    ordering_fields = ['created_at', 'updated_at', 'title', 'id']
    filterset_class = GenericFileFilter

    def get_queryset(self):
        if self.request.user.is_anonymous:
            return GenericFile.objects.none()
        return GenericFile.objects.filter(
            owner=self.request.user,
        ).prefetch_related('variants', 'webp')

    def create(self, request, *args, **kwargs):
        """
        Refuse instead of writing a fileless orphan row.

        `FeaturedImageSerializer.Meta.fields` has no `file`, so a POST here
        has never been able to produce a usable record: it stores `file=''`
        and `mime_type=''` (both `NOT NULL`, both satisfied by the empty
        string, and `Model.save()` runs no `full_clean()`), then answers 201
        with `url='/uploadz/public/'` and a `mime_type` that is not a member
        of the enum every generated client was handed. Uploading is
        `POST /uploads/handle` / `POST /uploads/single-public`, which sniff
        the bytes.

        This was masked until `mime_type` became read-only: it was the last
        required writable field, so a bodiless POST 400'd on it by accident.
        Making it read-only — which is what it always should have been —
        removes that accident and leaves every remaining field optional.
        Turning "you get a junk row only if you send a `mime_type`" into "you
        get a junk row from an empty body" is not an acceptable side effect of
        a hardening change, so the refusal is explicit rather than incidental.

        **Unconditional, on purpose.** The first version of this guard keyed
        off `'file' in Meta.fields` so it would lift itself once someone
        completed the endpoint. The codex adversarial review pointed out what
        that actually is: a serializer-field membership check standing in for
        an authorization decision. Adding `file` to `Meta.fields` for any
        reason — including read-only, purely to expose the stored name — would
        silently enable a generic `ModelViewSet.create()` that does no
        `validate_upload()` byte sniffing, no EXIF stripping, and never passes
        the `/uploads/` nginx size authorization (a zero-balance account is
        capped at 5 MiB there; nginx's raw request ceiling is 5 GiB, but the
        per-tier authorization limit is lower). Re-enabling
        creation must be a deliberate, reviewed change to THIS method, not a
        side effect of editing a field list.
        """
        raise ValidationError({
            'file': [
                'This endpoint cannot accept a file. Upload through '
                '/uploads/handle (batch) or /uploads/single-public (one '
                'file), then edit the record here.'
            ],
        })

    def perform_create(self, serializer):
        # Unreachable while `create` above refuses, and kept deliberately: it
        # is the piece a real implementation needs and the piece that is easy
        # to get wrong. `owner` is not a serializer field, so without this a
        # POST created an ownerless row that its creator could never see
        # again.
        serializer.save(owner=self.request.user)

    def perform_destroy(self, instance):
        """
        Refuse to delete a file that something else would be deleted WITH.

        Every other reference to `GenericFile` is `SET_NULL` — a zPage loses
        its cover, a creator loses their avatar, and the row survives. Exactly
        one is `CASCADE`: `storytime.Page.image` (`storytime/models.py`). So
        deleting a story illustration silently deletes the story page too,
        prompt, text, ordering and all — content the creator PAID 2Z to
        generate (`storytime/views.py` debits 1 2Z per page).

        That was tolerable while nothing in the product called this endpoint.
         puts a delete button on every row of the media dashboard, which
        turns a latent cascade into a routine one, so the guard belongs here —
        on the server, where the client cannot skip it — rather than in the
        dialog's wording.

        409 rather than 400: the request is well-formed, the resource's
        current state is what forbids it, and `detail` names the thing that
        has to go first.
        """
        used_by_pages = instance.story_pages.count()
        if used_by_pages:
            raise Conflict(
                f'This file illustrates {used_by_pages} story '
                f'{"page" if used_by_pages == 1 else "pages"}. Delete '
                f'{"that page" if used_by_pages == 1 else "those pages"} '
                f'first, or the story content would be deleted with it.'
            )
        instance.delete()
