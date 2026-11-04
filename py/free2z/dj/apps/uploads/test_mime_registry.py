"""
Pin the served Content-Type of every upload extension we care about.

This is the test that would have caught 288 WebP objects being served as
``application/octet-stream``. It has no database and no fixtures on purpose:
it asserts a property of the *process*, namely that by the time Django is up,
``mimetypes.guess_type`` answers what ``dj/util/mimetypes_registry.py`` says —
regardless of interpreter version or base image.

Two kinds of change would silently break uploads without it:

* a base-image bump in ``docker/py3base/Dockerfile`` ( moved it from
  ``python:3.10-bullseye`` to ``python:3.12-bookworm`` with this test green);
* any "shrink the runtime image" change to a ``-slim``/``-alpine`` variant,
  which drops ``/etc/mime.types`` — the *only* reason ``.jfif`` (50 objects),
  ``.m4a`` (8) and ``.m4v`` (4) resolve at all, at any Python version including
  3.13.

If you are here because this test just went red after a base-image or Python
bump: nothing is wrong with your bump. The registry is now the authority; the
failure means the interpreter/OS table disagrees with it, which is exactly the
condition this test exists to make visible rather than to prevent.
"""
import mimetypes
from pathlib import Path

import pytest

from dj.util.mimetypes_registry import (
    ACTIVE_CONTENT_TYPES,
    MIME_TYPE_REGISTRY,
    check_registry_is_passive,
    content_type_for,
    register_mime_types,
)


REPO_ROOT = Path(__file__).resolve().parents[5]
MEDIA_MIME_PREFIXES = ('image/', 'video/', 'audio/')


@pytest.mark.parametrize(
    ('extension', 'expected'),
    sorted(MIME_TYPE_REGISTRY.items()),
    ids=sorted(MIME_TYPE_REGISTRY),
)
def test_guess_type_matches_the_registry(extension, expected):
    """
    The header django-storages will stamp on the GCS blob
    (``mimetypes.guess_type(name)`` — storages/backends/gcloud.py:45) must be
    what the registry promises, for every extension in it.
    """
    guessed, _encoding = mimetypes.guess_type(f'somefile{extension}')
    assert guessed == expected, (
        f'\n\n"{extension}" would be served as {guessed!r}, but '
        f'dj/util/mimetypes_registry.py promises {expected!r}.\n'
        'django-storages sets the GCS blob content_type from '
        'mimetypes.guess_type(name) and nothing else, so this IS the header '
        'browsers get from /uploadz/.\n'
        'If you just changed the Python version or the base image: that is '
        'the cause. Fix register_mime_types() / the registry, do not relax '
        'this assertion.\n'
    )


@pytest.mark.parametrize(
    ('extension', 'expected'),
    [
        # The  bug itself: None on the then-pinned python:3.10-bullseye.
        ('.webp', 'image/webp'),
        # None on 3.10; present from 3.11 stdlib. Do not depend on that.
        ('.avif', 'image/avif'),
        ('.heic', 'image/heic'),
        # image/heic, not image/heif: the  allowlist canonicalizes both
        # extensions to image/heic, and the served type must equal the type
        # the API reports. Python's own table says image/heif.
        ('.heif', 'image/heic'),
        # audio/mpeg on the pinned image (wrong:.m4a is MPEG-4 audio) and
        # absent from CPython's own table at EVERY version, 3.13 included.
        ('.m4a', 'audio/mp4'),
        # Same: /etc/mime.types only.
        ('.m4v', 'video/mp4'),
        ('.jfif', 'image/jpeg'),
    ],
)
def test_the_extensions_that_were_actually_broken_in_production(
        extension, expected):
    assert mimetypes.guess_type(f'photo{extension}')[0] == expected


def test_uppercase_extensions_resolve_too():
    """
    Uploaded names routinely arrive as ``IMG_0001.JPG`` / ``pic.WEBP``.
    mimetypes lowercases the suffix itself; assert it, because the backfill
    command's planner lowercases explicitly and the two must agree.
    """
    assert mimetypes.guess_type('PIC.WEBP')[0] == 'image/webp'
    assert content_type_for('PIC.WEBP') == 'image/webp'


def test_content_type_for_agrees_with_guess_type():
    """
    ``content_type_for`` plans the backfill without touching storage. It must
    predict the real header exactly, or the backfill would write a value that
    new uploads of the same extension do not get.
    """
    for extension, expected in MIME_TYPE_REGISTRY.items():
        name = f'someone/a-file{extension}'
        assert content_type_for(name) == expected
        assert mimetypes.guess_type(name)[0] == expected


def test_content_type_for_declines_unregistered_and_degenerate_names():
    for name in ('', 'noextension', 'archive.tar.xz', 'evil.svg',
                 'page.html', 'script.js', '.webp', 'weird.'):
        assert content_type_for(name) is None, name


def test_registry_never_serves_an_active_document_type():
    """
     is stored XSS via an upload served as an active type from the
    cookie-bearing free2z.cash origin. The registry is the one place that
    could re-introduce it by hand, and the backfill command only ever writes
    values that come from here — so this assertion is what makes the backfill
    safe by construction.
    """
    check_registry_is_passive()
    for extension, content_type in MIME_TYPE_REGISTRY.items():
        assert content_type not in ACTIVE_CONTENT_TYPES, extension
        assert not content_type.startswith('text/'), extension
        assert 'script' not in content_type, extension
        assert 'xml' not in content_type, extension
        assert 'html' not in content_type, extension




def test_check_registry_is_passive_rejects_an_active_entry():
    with pytest.raises(AssertionError, match='ACTIVE'):
        check_registry_is_passive({'.svg': 'image/svg+xml'})
    with pytest.raises(AssertionError, match='ACTIVE'):
        check_registry_is_passive({'.htm': 'text/html; charset=utf-8'})


def test_check_registry_is_passive_rejects_malformed_keys():
    for bad in ({'webp': 'image/webp'}, {'.WEBP': 'image/webp'}, {'.': 'x/y'}):
        with pytest.raises(AssertionError, match='lowercase, dot-prefixed'):
            check_registry_is_passive(bad)


# --------------------------------------------------------------------------
# Reconciliation with the  upload allowlist (dj.apps.uploads.validation).
#
# Two maps of extension -> content type now exist. They answer different
# questions (accepted vs served) but they must give the same answer, or an
# upload is stored under a type the API does not report. These tests are the
# thing that keeps them from drifting until validation is rewritten to derive
# its types from the registry.
# --------------------------------------------------------------------------
def test_registry_is_a_superset_of_the_962_allowlist():
    from dj.apps.uploads import validation

    missing = sorted(
        set(validation.EXTENSION_TO_TYPE) - set(MIME_TYPE_REGISTRY))
    assert not missing, (
        f'{missing} can be uploaded but has no registered served type, so '
        'it would be stored as application/octet-stream. Add it to '
        'dj/util/mimetypes_registry.py.'
    )
    disagreements = {
        ext: (allowed, MIME_TYPE_REGISTRY[ext])
        for ext, allowed in validation.EXTENSION_TO_TYPE.items()
        if MIME_TYPE_REGISTRY[ext] != allowed
    }
    assert not disagreements, (
        'the upload allowlist and the MIME registry disagree about '
        f'{sorted(disagreements)}: {disagreements!r}. The first value is '
        'what the API and the DB mime_type column report; the second is the '
        'Content-Type the browser actually gets. They must be identical.'
    )


def test_allowlisted_upload_is_served_as_the_type_the_api_reports():
    """End-to-end restatement of the above, through the real guess_type."""
    from dj.apps.uploads import validation

    for ext, canonical in validation.EXTENSION_TO_TYPE.items():
        assert mimetypes.guess_type(f'creator/upload{ext}')[0] == canonical, ext


def test_active_set_covers_the_962_active_types():
    """
    Two denylists is one too many. ``ACTIVE_CONTENT_TYPES`` must contain
    everything the security boundary in ``validation`` treats as active, or a
    later registry edit could add an entry that this module waves through and
    that module would have blocked.
    """
    from dj.apps.uploads import validation

    uncovered = sorted(validation.ACTIVE_MIME_TYPES - ACTIVE_CONTENT_TYPES)
    assert not uncovered, (
        f'validation.ACTIVE_MIME_TYPES contains {uncovered}, which '
        'dj/util/mimetypes_registry.ACTIVE_CONTENT_TYPES does not. Add them '
        'there so check_registry_is_passive() is at least as strict as the '
        '#962 boundary.'
    )


def test_no_active_extension_is_registered():
    """
    ``validation.ACTIVE_EXTENSIONS`` is the  list of extensions a browser
    would execute (.svg,.html,.js,.swf,.jar,...). None may appear in the
    registry, which is what stops the backfill from ever planning one.
    """
    from dj.apps.uploads import validation

    overlap = sorted(validation.ACTIVE_EXTENSIONS & set(MIME_TYPE_REGISTRY))
    assert not overlap, (
        f'{overlap} are active-document extensions (#962) and must never be '
        'in MIME_TYPE_REGISTRY: the backfill command plans work from that '
        'map, so registering one would point it at exactly the objects it '
        'must never touch.'
    )


def test_registrations_survive_a_third_party_mimetypes_init():
    """
    ``mimetypes.init()`` rebuilds the module-level database from the built-in
    table plus ``/etc/mime.types``, discarding every prior ``add_type``. That
    is why ``UploadsConfig.ready()`` re-applies the registry: a dependency
    calling ``init()`` during app import would otherwise take.webp back to
    ``application/octet-stream`` in production with CI still green.
    """
    try:
        mimetypes.init()
        # Whether this is broken right now depends on the interpreter and the
        # image — which is the whole point — so don't assert on it here.
        register_mime_types()
        for extension, expected in MIME_TYPE_REGISTRY.items():
            assert mimetypes.guess_type(f'x{extension}')[0] == expected
    finally:
        # Leave the process exactly as the rest of the suite expects it.
        register_mime_types()
