"""
Safety and behaviour of ``backfill_upload_content_types``.

The command rewrites GCS blob metadata for objects uploaded before the MIME
registry existed. The properties worth testing are the ones that make it safe
to point at production:

* it can never write an **active** document type (that would be manufacturing
   rather than fixing ),
* it never touches an extension it has no registered target for,
* it writes nothing without ``--apply``,
* ``--json`` puts *only* JSON on stdout, so operational chatter cannot corrupt
  a machine consumer (the bug 's review found in ``audit_active_uploads``).
"""
import io
import json

import pytest
from django.core.files.base import ContentFile
from django.core.management import call_command
from django.core.management.base import CommandError

from dj.apps.uploads.management.commands import backfill_upload_content_types \
    as backfill
from dj.apps.uploads.models import GenericFile
from dj.util.mimetypes_registry import ACTIVE_CONTENT_TYPES, MIME_TYPE_REGISTRY


@pytest.fixture(autouse=True)
def _local_media(settings, tmp_path):
    """
    Default storage in settings is GCS; only that external boundary is
    swapped (per repo test rules -- the database stays real Postgres).
    """
    settings.STORAGES = {
        **settings.STORAGES,
        'default': {
            'BACKEND': 'django.core.files.storage.FileSystemStorage',
        },
    }
    settings.MEDIA_ROOT = str(tmp_path)
    settings.GS_BUCKET_NAME = "synthetic-content-types-bucket"


def _run(*args, **kwargs):
    out, err = io.StringIO(), io.StringIO()
    call_command(
        'backfill_upload_content_types', *args,
        stdout=out, stderr=err, **kwargs,
    )
    return out.getvalue(), err.getvalue()


# --------------------------------------------------------------------------
# The safety guard, tested directly -- no DB, no storage.
# --------------------------------------------------------------------------
@pytest.mark.parametrize('active', sorted(ACTIVE_CONTENT_TYPES))
def test_refuses_to_write_any_active_document_type(active):
    with pytest.raises(CommandError):
        backfill._assert_safe_target(active)


def test_refuses_to_write_anything_outside_the_registry():
    with pytest.raises(CommandError, match='not a value in'):
        backfill._assert_safe_target('application/x-made-up')


@pytest.mark.parametrize('content_type', sorted(set(MIME_TYPE_REGISTRY.values())))
def test_accepts_every_registry_value(content_type):
    backfill._assert_safe_target(content_type)


def test_no_registry_value_is_active():
    """
    This is what makes the command safe *by construction* rather than by
    review: the only strings it can ever write are registry values.
    """
    assert not set(MIME_TYPE_REGISTRY.values()) & ACTIVE_CONTENT_TYPES


# --------------------------------------------------------------------------
# Argument handling.
# --------------------------------------------------------------------------
def test_unregistered_extension_is_rejected_loudly():
    with pytest.raises(CommandError, match='MIME_TYPE_REGISTRY'):
        _run('--extensions', 'svg')
    with pytest.raises(CommandError, match='MIME_TYPE_REGISTRY'):
        _run('--extensions', 'html')


def test_unknown_field_label_is_rejected():
    with pytest.raises(CommandError, match='unknown --fields'):
        _run('--fields', 'nope')


@pytest.mark.django_db
def test_apply_against_non_gcs_storage_fails_instead_of_guessing(settings):
    """
    Local/dev storage has no blob metadata at all. Fail with an explanation
    rather than silently reporting success.
    """
    with pytest.raises(CommandError, match='no GCS bucket'):
        _run('--apply', '--bucket', settings.GS_BUCKET_NAME)


def test_apply_requires_naming_the_bucket():
    """
    GS_BUCKET_NAME is hardcoded and un-namespaced, so `manage.py... --apply`
    from a developer laptop writes to the PRODUCTION bucket. Make the
    operator say the name out loud.
    """
    with pytest.raises(CommandError, match='requires --bucket'):
        _run('--apply')


def test_apply_refuses_a_bucket_name_that_is_not_the_configured_one(settings):
    with pytest.raises(CommandError, match='does not match the configured'):
        _run('--apply', '--bucket', 'some-other-bucket')
    # Sanity: the guard is comparing against the real setting.
    assert settings.GS_BUCKET_NAME


# --------------------------------------------------------------------------
# Planning against real rows (report-only, no storage access).
# --------------------------------------------------------------------------
@pytest.mark.django_db
def test_dry_run_plans_the_broken_extensions_and_skips_active_ones(
        creator_factory):
    owner = creator_factory()
    broken = GenericFile.objects.create(
        owner=owner, mime_type='image/webp',
        file=ContentFile(b'RIFFxxxxWEBP', name='pic.webp'),
    )
    GenericFile.objects.create(
        owner=owner, mime_type='image/svg+xml',
        file=ContentFile(b'<svg/>', name='evil.svg'),
    )
    GenericFile.objects.create(
        owner=owner, mime_type='image/png',
        file=ContentFile(b'\x89PNG', name='fine.png'),
    )

    out, _err = _run('--json')
    report = json.loads(out)

    names = {row['name'] for row in report['needs_update']}
    assert any(name.endswith('.webp') for name in names)
    # An active-typed object is never planned, never read, never written.
    assert not any(name.endswith('.svg') for name in names)
    assert report['skipped_unregistered_extension'] >= 1
    assert report['applied'] is False
    assert report['updated'] == 0

    targets = {
        row['name']: row['target_content_type']
        for row in report['needs_update']
    }
    assert targets[broken.file.name] == 'image/webp'


@pytest.mark.django_db
def test_extension_filter_scopes_the_plan(creator_factory):
    owner = creator_factory()
    GenericFile.objects.create(
        owner=owner, mime_type='image/webp',
        file=ContentFile(b'x', name='pic.webp'),
    )
    GenericFile.objects.create(
        owner=owner, mime_type='image/png',
        file=ContentFile(b'x', name='pic.png'),
    )

    out, _err = _run('--json', '--extensions', 'webp')
    report = json.loads(out)
    assert report['extensions'] == ['.webp']
    assert all(r['name'].endswith('.webp') for r in report['needs_update'])


@pytest.mark.django_db
def test_json_mode_puts_nothing_but_json_on_stdout(creator_factory):
    """
    's review found its JSON mode corrupted by operational text on stdout.
    Every human message in this command goes to stderr; assert it, including
    the dry-run warning, which is exactly the message that would break a
    `| jq` pipeline.
    """
    owner = creator_factory()
    GenericFile.objects.create(
        owner=owner, mime_type='image/webp',
        file=ContentFile(b'x', name='pic.webp'),
    )
    out, _err = _run('--json')
    json.loads(out)  # raises if a single stray byte landed on stdout


@pytest.mark.django_db
def test_json_report_carries_the_cdn_invalidation_field(creator_factory):
    owner = creator_factory()
    GenericFile.objects.create(
        owner=owner, mime_type='image/webp',
        file=ContentFile(b'x', name='pic.webp'),
    )
    report = json.loads(_run('--json')[0])
    assert report['cdn_invalidation_required'] is False  # nothing applied
    assert 'invalidate-cdn-cache' in report['cdn_invalidation_command']
    assert "--path '/uploadz/*'" in report['cdn_invalidation_command']
    assert "--path '/og/zpage/*'" in report['cdn_invalidation_command']


@pytest.mark.django_db
def test_text_report_mentions_the_cdn_and_says_it_changed_nothing(
        creator_factory):
    owner = creator_factory()
    GenericFile.objects.create(
        owner=owner, mime_type='image/webp',
        file=ContentFile(b'x', name='pic.webp'),
    )
    out, err = _run()
    assert 'Report only' in out
    assert 'DRY RUN' in err  # operational chatter, on stderr


# --------------------------------------------------------------------------
# Remote reconciliation, with a stand-in bucket.
# --------------------------------------------------------------------------
class _Blob:
    def __init__(self, content_type):
        self.content_type = content_type
        self.patched = 0

    def patch(self):
        self.patched += 1


class _Bucket:
    """Minimal stand-in for google.cloud.storage.Bucket."""

    def __init__(self, blobs):
        self.blobs = blobs

    def get_blob(self, name):
        return self.blobs.get(name)


@pytest.mark.django_db
def test_check_remote_separates_correct_wrong_and_missing(
        creator_factory, monkeypatch):
    owner = creator_factory()
    wrong = GenericFile.objects.create(
        owner=owner, mime_type='image/webp',
        file=ContentFile(b'x', name='wrong.webp'),
    )
    right = GenericFile.objects.create(
        owner=owner, mime_type='image/webp',
        file=ContentFile(b'x', name='right.webp'),
    )
    gone = GenericFile.objects.create(
        owner=owner, mime_type='image/webp',
        file=ContentFile(b'x', name='gone.webp'),
    )

    blobs = {
        wrong.file.name: _Blob('application/octet-stream'),
        right.file.name: _Blob('image/webp'),
        # `gone` deliberately absent: DB row with no object in the bucket.
    }
    bucket = _Bucket(blobs)
    monkeypatch.setattr(
        backfill.Command, '_get_bucket', lambda self: bucket)

    report = json.loads(
        _run('--json', '--check-remote', '--extensions', 'webp')[0])

    assert report['already_correct'] == 1
    assert [r['name'] for r in report['needs_update']] == [wrong.file.name]
    assert report['needs_update'][0]['current_content_type'] == \
        'application/octet-stream'
    assert [r['name'] for r in report['missing_objects']] == [gone.file.name]
    # Read-only: nothing was patched.
    assert all(blob.patched == 0 for blob in blobs.values())


@pytest.mark.django_db
def test_apply_patches_only_the_wrong_object_and_flags_the_cdn(
        creator_factory, monkeypatch, settings):
    owner = creator_factory()
    wrong = GenericFile.objects.create(
        owner=owner, mime_type='image/webp',
        file=ContentFile(b'x', name='wrong.webp'),
    )
    right = GenericFile.objects.create(
        owner=owner, mime_type='image/webp',
        file=ContentFile(b'x', name='right.webp'),
    )
    blobs = {
        wrong.file.name: _Blob('application/octet-stream'),
        right.file.name: _Blob('image/webp'),
    }
    monkeypatch.setattr(
        backfill.Command, '_get_bucket', lambda self: _Bucket(blobs))

    report = json.loads(
        _run('--json', '--apply', '--extensions', 'webp',
             '--bucket', settings.GS_BUCKET_NAME)[0])

    assert report['updated'] == 1
    assert report['cdn_invalidation_required'] is True
    assert blobs[wrong.file.name].content_type == 'image/webp'
    assert blobs[wrong.file.name].patched == 1
    # The already-correct object is never touched.
    assert blobs[right.file.name].patched == 0


@pytest.mark.django_db
def test_write_failures_are_reported_and_exit_non_zero(
        creator_factory, monkeypatch, settings):
    """
    The dangerous failure is credentials that can READ but not WRITE: every
    preflight lookup succeeds, every patch() 403s, and a command that exits 0
    with `updated: 0` tells the operator remediation is done when nothing
    changed. It must fail loudly, and the failures must be in the report.
    """
    owner = creator_factory()
    rows = [
        GenericFile.objects.create(
            owner=owner, mime_type='image/webp',
            file=ContentFile(b'x', name=f'pic{i}.webp'),
        )
        for i in range(3)
    ]

    class _ReadOnlyBlob(_Blob):
        def patch(self):
            raise PermissionError('403 storage.objects.update denied')

    blobs = {r.file.name: _ReadOnlyBlob('application/octet-stream')
             for r in rows}
    monkeypatch.setattr(
        backfill.Command, '_get_bucket', lambda self: _Bucket(blobs))

    out = io.StringIO()
    err = io.StringIO()
    with pytest.raises(CommandError, match='INCOMPLETE'):
        call_command(
            'backfill_upload_content_types', '--json', '--apply',
            '--extensions', 'webp', '--bucket', settings.GS_BUCKET_NAME,
            stdout=out, stderr=err,
        )
    # The evidence is emitted before the failure, and stdout is still JSON.
    report = json.loads(out.getvalue())
    assert report['updated'] == 0
    assert report['complete'] is False
    assert len(report['errors']) == 3
    assert '403' in report['errors'][0]['error']


@pytest.mark.django_db
def test_a_clean_apply_reports_complete(creator_factory, monkeypatch,
                                        settings):
    owner = creator_factory()
    row = GenericFile.objects.create(
        owner=owner, mime_type='image/webp',
        file=ContentFile(b'x', name='pic.webp'),
    )
    monkeypatch.setattr(
        backfill.Command, '_get_bucket',
        lambda self: _Bucket({row.file.name: _Blob('application/octet-stream')}))

    report = json.loads(
        _run('--json', '--apply', '--extensions', 'webp',
             '--bucket', settings.GS_BUCKET_NAME)[0])
    assert report['complete'] is True
    assert report['errors'] == []


@pytest.mark.django_db
def test_repeated_lookup_failures_abort_instead_of_grinding_on(
        creator_factory, monkeypatch, settings):
    """
    Bad credentials or the wrong bucket fail on *every* object. Without this
    guard the operator gets 22,900 identical stack traces and a report that
    looks like data loss; with it, one readable error and no writes.
    """
    owner = creator_factory()
    for i in range(5):
        GenericFile.objects.create(
            owner=owner, mime_type='image/webp',
            file=ContentFile(b'x', name=f'pic{i}.webp'),
        )

    class _BrokenBucket:
        def get_blob(self, name):
            raise RuntimeError('invalid_grant: Bad Request')

    monkeypatch.setattr(
        backfill.Command, '_get_bucket', lambda self: _BrokenBucket())

    with pytest.raises(CommandError, match='aborting after'):
        _run('--json', '--apply', '--extensions', 'webp',
             '--bucket', settings.GS_BUCKET_NAME, '--max-errors', '2')


@pytest.mark.django_db
def test_apply_never_reads_or_writes_an_active_typed_object(
        creator_factory, monkeypatch, settings):
    """
    An.svg row must not even be looked up: it has no registered target, so it
    never enters the plan. This is the property that keeps a  repair from
    becoming a  regression.
    """
    owner = creator_factory()
    svg = GenericFile.objects.create(
        owner=owner, mime_type='image/svg+xml',
        file=ContentFile(b'<svg/>', name='evil.svg'),
    )
    looked_up = []

    class _SpyBucket(_Bucket):
        def get_blob(self, name):
            looked_up.append(name)
            return super().get_blob(name)

    monkeypatch.setattr(
        backfill.Command, '_get_bucket', lambda self: _SpyBucket({}))

    json.loads(_run('--json', '--apply',
                    '--bucket', settings.GS_BUCKET_NAME)[0])
    assert svg.file.name not in looked_up


# --------------------------------------------------------------------------
# Source discovery.
#
# The first version of this command hardcoded the three `uploads` models and
# silently skipped `kyc`, whose identity documents live in the same bucket and
# get their Content-Type from the same guess_type call. Discovery is what
# makes "did you list every model?" un-askable.
# --------------------------------------------------------------------------
def test_discovery_finds_every_default_storage_filefield():
    from django.apps import apps as django_apps
    from django.core.files.storage import default_storage
    from django.db import models as dj_models

    expected = set()
    for model in django_apps.get_models():
        for field in model._meta.get_fields():
            if isinstance(field, dj_models.FileField) and \
                    getattr(field, 'storage', None) is default_storage:
                expected.add(f'{model._meta.label_lower}.{field.name}')

    assert set(backfill.discover_sources()) == expected
    assert expected, 'discovery found nothing at all -- it is broken'


def test_discovery_includes_the_kyc_identity_documents():
    """
    Regression for the codex finding: UserProfile.id_front and friends are
    WebP-capable, live in the uploads bucket, and were being skipped.
    """
    found = set(backfill.discover_sources())
    for label in (
        'kyc.userprofile.id_front',
        'kyc.userprofile.id_back',
        'kyc.userprofile.live_photo',
        'kyc.userprofile.additional_document',
        'uploads.genericfile.file',
        'uploads.webp.file',
        'uploads.imagevariant.file',
    ):
        assert label in found, label


def test_list_fields_is_pure_json_in_json_mode():
    out, _err = _run('--list-fields', '--json')
    payload = json.loads(out)
    assert 'uploads.genericfile.file' in payload['fields']


@pytest.mark.django_db
def test_missing_objects_keep_complete_false(
        creator_factory, monkeypatch, settings):
    """
    If every candidate is absent from the bucket, `wanted` is 0 and `updated`
    is 0 -- which must NOT read as success. Automation gates on `complete`.
    """
    owner = creator_factory()
    GenericFile.objects.create(
        owner=owner, mime_type='image/webp',
        file=ContentFile(b'x', name='gone.webp'),
    )
    monkeypatch.setattr(
        backfill.Command, '_get_bucket', lambda self: _Bucket({}))

    out = io.StringIO()
    err = io.StringIO()
    with pytest.raises(CommandError, match='INCOMPLETE'):
        call_command(
            'backfill_upload_content_types', '--json', '--apply',
            '--extensions', 'webp', '--bucket', settings.GS_BUCKET_NAME,
            stdout=out, stderr=err,
        )
    report = json.loads(out.getvalue())
    assert report['complete'] is False
    assert len(report['missing_objects']) == 1


@pytest.mark.django_db
def test_a_limited_apply_is_never_reported_as_complete(
        creator_factory, monkeypatch, settings):
    """
    `--apply --limit 1` over 3 broken objects repairs a prefix. Re-running it
    re-plans that same prefix (now already correct) and never reaches the
    tail, so reporting completion would strand the rest forever.
    """
    owner = creator_factory()
    rows = [
        GenericFile.objects.create(
            owner=owner, mime_type='image/webp',
            file=ContentFile(b'x', name=f'pic{i}.webp'),
        )
        for i in range(3)
    ]
    blobs = {r.file.name: _Blob('application/octet-stream') for r in rows}
    monkeypatch.setattr(
        backfill.Command, '_get_bucket', lambda self: _Bucket(blobs))

    out, err = io.StringIO(), io.StringIO()
    with pytest.raises(CommandError, match='TRUNCATED'):
        call_command(
            'backfill_upload_content_types', '--json', '--apply',
            '--extensions', 'webp', '--limit', '1',
            '--bucket', settings.GS_BUCKET_NAME, stdout=out, stderr=err,
        )
    report = json.loads(out.getvalue())
    assert report['truncated_by_limit'] is True
    assert report['complete'] is False
    assert report['updated'] == 1


def test_negative_limit_is_rejected():
    with pytest.raises(CommandError, match=r'--limit must be >= 0'):
        _run('--limit', '-1')


@pytest.mark.django_db
def test_aborting_on_lookup_errors_still_emits_the_json_report(
        creator_factory, monkeypatch, settings):
    """
    --json promises structured output. Expired credentials at 3am must not
    produce an empty stdout: the error list is the whole diagnostic.
    """
    owner = creator_factory()
    for i in range(4):
        GenericFile.objects.create(
            owner=owner, mime_type='image/webp',
            file=ContentFile(b'x', name=f'pic{i}.webp'),
        )

    class _BrokenBucket:
        def get_blob(self, name):
            raise RuntimeError('invalid_grant: Bad Request')

    monkeypatch.setattr(
        backfill.Command, '_get_bucket', lambda self: _BrokenBucket())

    out, err = io.StringIO(), io.StringIO()
    with pytest.raises(CommandError, match='aborting after'):
        call_command(
            'backfill_upload_content_types', '--json', '--apply',
            '--extensions', 'webp', '--max-errors', '2',
            '--bucket', settings.GS_BUCKET_NAME, stdout=out, stderr=err,
        )
    report = json.loads(out.getvalue())
    assert report['complete'] is False
    assert len(report['errors']) == 2
    assert report['updated'] == 0
