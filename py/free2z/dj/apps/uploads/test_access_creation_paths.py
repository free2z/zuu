"""
Every server-side path that can bring a `GenericFile` row into existence, and
the access level each one produces ( items 3 and 4).

Two questions, and they are different:

  3. **Defaults.** `GenericFile.access` defaults to `public` on the model.
     Which creation paths take that default, and can any of them produce a
     row at a level its caller did not intend?
  4. **No copies.** Does anything create a SECOND row in order to change an
     access level?  removed the editor's re-upload; this is the proof
     that nothing else does it.

Answering either one by reading the code is how a path gets missed, so the
enumeration is machine-made: `_construction_sites()` walks the AST of every
`.py` file under `py/` and finds every direct `GenericFile(...)` /
`GenericFile.objects.<writer>(...)`. A new creation path fails
`test_generic_file_construction_sites_are_all_enumerated` until it is added
to `CONSTRUCTION_SITES` with its level recorded — which is the audit trail
this issue asked for, kept honest by CI rather than by memory.

**What the AST walk does NOT see**, and is covered by named tests instead
(the adversarial review's finding 3 — the first version of this docstring
said "complete", which it is not):

  * `serializer.save()` — the two HTTP upload endpoints. Covered
    behaviourally by `test_batch_upload_...` /
    `test_single_public_upload_...`, and
    `test_the_only_writable_generic_file_serializers_are_the_known_two`
    fails if a third serializer for this model appears.
  * the **Django admin**, whose `GenericFileAdmin` add form is a real
    creation path with `access` editable. Pinned by
    `test_the_admin_is_a_staff_only_creation_path_with_an_editable_level`.
  * a row created through an alias (`Model = GenericFile`) or by
    `apps.get_model`. Nothing does that today; neither the walk nor a
    reviewer would catch it, and it is stated here rather than implied.

Nothing here changes production behaviour. Defaults are a product decision.
"""
import ast
import json
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

from django.core.files.base import ContentFile
from django.urls import reverse

from dj.apps.uploads.models import GenericFile


PY_ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture(autouse=True)
def _local_media(settings, tmp_path):
    settings.STORAGES = {
        **settings.STORAGES,
        "default": {
            "BACKEND": "django.core.files.storage.FileSystemStorage",
        },
    }
    settings.MEDIA_ROOT = str(tmp_path)


def _png_bytes():
    image = Image.new("RGB", (8, 8), (10, 120, 200))
    out = BytesIO()
    image.save(out, format="PNG")
    return out.getvalue()


def _upload(name="pic.png"):
    upload = ContentFile(_png_bytes(), name=name)
    upload.content_type = "image/png"
    return upload


# --------------------------------------------------------------------------
# the enumeration
# --------------------------------------------------------------------------

#Manager methods that write a row. `bulk_create` and the async spellings are
#here because the adversarial review pointed out the first version matched
#only `create` — a `bulk_create` would have been invisible.
_WRITING_MANAGER_METHODS = {
    "create", "acreate", "get_or_create", "aget_or_create",
    "update_or_create", "aupdate_or_create", "bulk_create", "abulk_create",
}


def _is_generic_file_call(node):
    """`GenericFile(...)`, `GenericFile.objects.<writer>(...)`, or the
    `cls.objects.create(...)` inside `GenericFile.create_from_prompt`."""
    func = node.func
    if isinstance(func, ast.Name) and func.id == "GenericFile":
        return True
    if (
        isinstance(func, ast.Attribute)
        and func.attr in _WRITING_MANAGER_METHODS
        and isinstance(func.value, ast.Attribute)
        and func.value.attr == "objects"
        and isinstance(func.value.value, ast.Name)
        and func.value.value.id in {"GenericFile", "cls"}
    ):
        return True
    return False


def _access_kwarg(node):
    """
    What this call passes as `access`, as one comparable token:

      * ``None``            — no `access=` at all, so the row takes the model
                              default (`public`);
      * ``"'members'"``     — a literal, recorded verbatim;
      * ``"<dynamic>"``     — an EXPRESSION. This is the alarming one: a level
                              computed at creation time is the exact shape of
                              "make a row at the level this consumer wants",
                              i.e. the copy anti-pattern from.
    """
    for kw in node.keywords:
        # `**something` — the keywords are not visible at all, so nothing can
        # be said about the level. Treated as dynamic rather than as absent
        # (adversarial review round 2, finding 4).
        if kw.arg is None:
            return "<dynamic>"
        if kw.arg == "defaults" and isinstance(kw.value, ast.Dict):
            # `get_or_create(defaults={"access":...})` writes through the
            # dict, not through a top-level keyword.
            for key, value in zip(kw.value.keys, kw.value.values):
                if isinstance(key, ast.Constant) and key.value == "access":
                    if isinstance(value, ast.Constant):
                        return repr(value.value)
                    return "<dynamic>"
        if kw.arg != "access":
            continue
        if isinstance(kw.value, ast.Constant):
            return repr(kw.value.value)
        return "<dynamic>"
    return None


def _copies_bytes_from_another_row(node):
    """
    Does this call hand `file=` something that came off another model
    instance — `file=source.file`, `file=other.file.name`?

    The adversarial review's finding 4: "no site passes `access=`" does not
    disprove a copy, because the privacy-breaking duplicate can simply omit
    `access` and take the public default. What actually distinguishes a copy
    is where its BYTES come from. A fresh upload passes an
    `UploadedFile`/`ContentFile` built in the same function; a copy reaches
    into an existing row.
    """
    for kw in node.keywords:
        if kw.arg != "file":
            continue
        value = kw.value
        # Unwrap calls so `file=source.file.open()` is seen too.
        while isinstance(value, (ast.Attribute, ast.Call)):
            if isinstance(value, ast.Call):
                value = value.func
                continue
            if value.attr == "file":
                return True
            value = value.value
    return False


def _construction_sites():
    """
    ``{"<path>:<enclosing def>": (access-token,...)}`` for the whole py/
    tree — one token per call, in source order.

    The value is a TUPLE and not a bool because of a negative control that
    failed: with a bool, a second `GenericFile.objects.create(...)` added
    inside an already-registered function overwrote the first one's entry and
    the enumeration stayed green. An added creation path is exactly what this
    test exists to catch, and "in a function that already creates one" is the
    likeliest place for it to appear.
    """
    sites = {}
    for path in sorted(PY_ROOT.rglob("*.py")):
        rel = path.relative_to(PY_ROOT).as_posix()
        if "/migrations/" in rel or rel.startswith("env/"):
            continue
        if Path(rel).name.startswith("test_") or "/tests/" in rel:
            continue
        try:
            tree = ast.parse(path.read_text(), filename=rel)
        except SyntaxError:  # pragma: no cover - not our source
            continue
        # `cls.objects.create` only counts inside uploads/models.py, where
        # `cls` really is GenericFile.
        allow_cls = rel.endswith("dj/apps/uploads/models.py")
        enclosing = {}
        for parent in ast.walk(tree):
            for child in ast.iter_child_nodes(parent):
                if isinstance(parent, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    enclosing[child] = parent.name
                elif parent in enclosing:
                    enclosing[child] = enclosing[parent]
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not _is_generic_file_call(
                    node):
                continue
            func = node.func
            if (
                isinstance(func, ast.Attribute)
                and isinstance(func.value, ast.Attribute)
                and isinstance(func.value.value, ast.Name)
                and func.value.value.id == "cls"
                and not allow_cls
            ):
                continue
            key = f"{rel}:{enclosing.get(node, '<module>')}"
            token = _access_kwarg(node)
            if _copies_bytes_from_another_row(node):
                token = f"{token}+COPIES-BYTES"
            sites.setdefault(key, []).append((node.lineno, token))
    return {
        key: tuple(token for _lineno, token in sorted(calls))
        for key, calls in sites.items()
    }


#The complete audited registry: every server-side path that can bring a
#`GenericFile` row into existence, and the level each one produces.
#
#`(None,)` means one call passing no `access=`, so the row lands at the
#model default — `public`. Every current path is in that state; see
#`test_batch_upload_...` for the two serializer-driven entry points, which
#are not direct constructor calls and so do not appear here.
#
#`("<dynamic>",)` means one call passing a computed expression. The ONLY
#such site is the Dyte recording downloader, which resolves the access tier
#from the recording's `CreatorMeeting.meeting_type`. It is
#intentional and fail-closed: any meeting that is not positively a broadcast
#is stored `private`, never public.
CONSTRUCTION_SITES = {
    # Dall-E image for an auto-posted tweet comment (the `free2z` account).
    "dj/apps/uploads/models.py:create_from_prompt": (None,),
    # Paid storytime page illustration -> `storytime.Page.image` (CASCADE).
    "dj/apps/storytime/views.py:post": (None,),
    # Paid AI image generation -> also creates the legacy `Webp` beside it.
    "dj/apps/openai/views.py:post": (None,),
    # A Dyte/RealtimeKit livestream recording, downloaded by a worker. The
    # construction passes the fail-closed `private` placeholder and the tier
    # is re-resolved inside the transaction.atomic() block immediately before
    # save() (broadcast -> public, subscribers-only -> members, ppv/private/
    # unknown -> private). THAT deferred resolution — not a decided literal —
    # is the whole point of: it is how a restricted recording stops
    # being stored public, so the computed expression is whitelisted here
    # rather than treated as a copy anti-pattern.
    "dj/apps/dyte/management/commands/dyte_download_upload.py:callback":
        ("<dynamic>",),
}


def test_generic_file_construction_sites_are_all_enumerated():
    """
    A new place that creates a `GenericFile` must be audited here, with the
    access level it produces recorded, before it can merge.

    This is deliberately the whole `py/` tree and not just `dj/apps/uploads`:
    four of the current five creation paths live in OTHER apps, which is
    exactly why "grep the uploads app" has never been a sufficient audit.
    """
    assert _construction_sites() == CONSTRUCTION_SITES


def test_the_enumeration_can_actually_see_a_new_creation_path():
    """
    Negative control for the enumerator itself, run in-process against a
    synthetic module: a matcher that silently found nothing would make the
    registry above look complete forever.
    """
    sample = ast.parse(
        "def handler():\n"
        "    GenericFile.objects.create(owner=u, file=f, mime_type='x')\n"
        "def other():\n"
        "    GenericFile(owner=u, access='members')\n"
        "def unrelated():\n"
        "    SomethingElse.objects.create(access='private')\n"
    )
    calls = [n for n in ast.walk(sample)
             if isinstance(n, ast.Call) and _is_generic_file_call(n)]
    assert len(calls) == 2
    assert [_access_kwarg(c) for c in calls] == [None, "'members'"]

    # And the token really does distinguish a computed level from a literal
    # one — the whole point of `<dynamic>`.
    computed = ast.parse(
        "GenericFile.objects.create(access=other.access)").body[0].value
    assert _access_kwarg(computed) == "<dynamic>"


def test_the_model_default_is_public_and_that_is_what_those_sites_get():
    """
    The behavioural half of the enumeration: `access` omitted really does
    mean `public`, so `False` in the registry above means "public".
    """
    assert GenericFile._meta.get_field("access").default == "public"


@pytest.mark.django_db
def test_a_row_created_without_an_access_kwarg_is_public(creator_factory):
    gfile = GenericFile.objects.create(
        owner=creator_factory(username="default-level"),
        file=ContentFile(_png_bytes(), name="pic.png"),
        mime_type="image/png",
    )
    assert gfile.access == "public"
    assert gfile.get_url().startswith("/uploadz/public/")


def test_no_migration_creates_a_generic_file_row():
    """
    Migrations are excluded from the AST walk (they are historical, and they
    reach models through `apps.get_model` rather than by name), which the
    adversarial review correctly called a hole: a `RunPython` backfill can
    `apps.get_model("uploads", "GenericFile").objects.create(...)` and mint
    default-`public` rows out of restricted legacy media the moment `migrate`
    finishes — with this audit green.

    So: no migration anywhere may create one. If a backfill genuinely needs
    to, it sets `access` explicitly and this test is updated to say so.
    """
    offenders = []
    for path in sorted(PY_ROOT.rglob("migrations/*.py")):
        source = path.read_text()
        if "GenericFile" not in source:
            continue
        tree = ast.parse(source, filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            if (
                isinstance(func, ast.Attribute)
                and func.attr in _WRITING_MANAGER_METHODS
            ):
                offenders.append(
                    f"{path.relative_to(PY_ROOT)}:{node.lineno}")
    assert not offenders, (
        "A migration writes rows in a module that mentions GenericFile:\n"
        + "\n".join(offenders)
        + "\nIf it creates GenericFile rows, it must set `access` explicitly "
          "and be recorded in this audit."
    )


def test_the_only_writable_generic_file_serializers_are_the_known_two():
    """
    The creation paths the AST walk cannot see are the ones that go through
    `serializer.save()`. Enumerate them by their MODEL rather than by name,
    so a new `ModelSerializer` for `GenericFile` anywhere in the codebase
    fails here until its `access` handling has been audited.
    """
    import importlib
    import pkgutil

    from django.apps import apps as django_apps
    from rest_framework.serializers import ModelSerializer

    # `__subclasses__()` only sees classes that have been IMPORTED, so a new
    # serializer in a lazily-imported module would be invisible and this test
    # would pass while missing it. Import every `serializers` module (or
    # package) under this project's own apps first.
    #
    # Scoped to `dj.` and to `serializers` on purpose: importing the whole
    # dependency tree instead runs third-party `__main__` modules, one of
    # which (daphne's) parses `sys.argv` and raises SystemExit — a
    # BaseException that `except Exception` does not even catch.
    failures = []
    for config in django_apps.get_app_configs():
        module = config.module
        if module is None or not module.__name__.startswith("dj."):
            continue
        if not hasattr(module, "__path__"):
            continue
        for info in pkgutil.walk_packages(
                module.__path__, prefix=f"{module.__name__}."):
            parts = info.name.split(".")
            if "serializers" not in parts or "migrations" in parts:
                continue
            if parts[-1].startswith("test_"):
                continue
            try:
                importlib.import_module(info.name)
            except BaseException as exc:
                failures.append(f"{info.name}: {exc!r}")

    # A swallowed ImportError is a module that silently vanishes from the
    # audit (adversarial review round 2, finding 3). Fail loudly instead.
    assert not failures, (
        "serializer modules failed to import, so they were not audited:\n"
        + "\n".join(failures)
    )

    def subclasses(cls):
        for sub in cls.__subclasses__():
            yield sub
            yield from subclasses(sub)

    # Keyed by module + qualname, NOT by bare `__name__`: two apps can each
    # define a `GenericFileSerializer`, and a set of bare names would absorb
    # the second one without changing.
    for_generic_file = {
        f"{sub.__module__}.{sub.__qualname__}"
        for sub in subclasses(ModelSerializer)
        if getattr(getattr(sub, "Meta", None), "model", None) is GenericFile
    }
    assert for_generic_file == {
        # POST /uploads/handle, POST /uploads/single-public
        "dj.apps.uploads.serializers.GenericFileSerializer",
        # /api/myuploads/ (create is closed)
        "dj.apps.uploads.serializers.FeaturedImageSerializer",
    }

    # `access` is writable on both, deliberately: it is what the media
    # dashboard edits and what an uploader declares. If either ever became
    # read-only, the level would be un-settable at upload time and every
    # row would land at the model default.
    from dj.apps.uploads.serializers import (
        FeaturedImageSerializer, GenericFileSerializer,
    )
    for serializer_class in (GenericFileSerializer, FeaturedImageSerializer):
        field = serializer_class().fields["access"]
        assert not field.read_only, serializer_class.__name__


@pytest.mark.django_db
def test_the_admin_is_a_staff_only_creation_path_with_an_editable_level(
        client, creator_factory):
    """
    `GenericFileAdmin` has no `has_add_permission = False`, so the Django
    admin add form is a genuine creation path — invisible to the AST walk,
    because the row is built by a ModelForm.

    Recorded, not changed. It is staff-only and `access` is editable on the
    add form, which is the right shape (a staff member picks the level
    explicitly rather than inheriting a default). What matters for this audit
    is that it EXISTS and is not a copy-maker: the form has no source row to
    copy from.
    """
    from django.contrib import admin as django_admin
    from dj.apps.uploads.admin import GenericFileAdmin

    site_admin = django_admin.site._registry[GenericFile]
    assert isinstance(site_admin, GenericFileAdmin)

    staff = creator_factory(username="admin-adder", is_staff=True,
                            is_superuser=True)
    request = type("R", (), {"user": staff})()
    assert site_admin.has_add_permission(request) is True
    # `access` is editable on ADD (it is only `file`/`mime_type` that go
    # read-only, and only on change) — so the level is chosen, not defaulted.
    assert "access" not in site_admin.get_readonly_fields(request, obj=None)

    # Not staff -> not a creation path at all.
    civilian = creator_factory(username="admin-civilian")
    assert site_admin.has_add_permission(
        type("R", (), {"user": civilian})()) is False


# --------------------------------------------------------------------------
# the two HTTP upload entry points
# --------------------------------------------------------------------------

@pytest.mark.django_db
@pytest.mark.parametrize("requested,expected", [
    (None, "public"),
    ("public", "public"),
    ("members", "members"),
    ("private", "private"),
])
def test_batch_upload_honours_the_requested_level_and_defaults_to_public(
        client, creator_factory, requested, expected):
    """
    `POST /uploads/handle` takes `access` from the client body through
    `GenericFileSerializer`, where it is writable on purpose. Omitting it
    falls through to the model default.

    That default is the one thing worth flagging: the *dashboard* uploader
    sends `private`, but the DEFAULT for any client that omits the field —
    including a third-party API client, and the API is the product — is
    `public`. Nothing here changes it;  item 3 asks for it to be
    recorded, and a default that publishes is the kind that should be an
    explicit product decision rather than a model-field fallback.
    """
    creator = creator_factory(username=f"batch-{requested}")
    client.force_login(creator)

    metadata = {"title": "pic", "name": "pic.png"}
    if requested is not None:
        metadata["access"] = requested

    response = client.post(
        reverse("uploads_handle"),
        {"body": json.dumps([metadata]), "files": _upload()},
    )

    assert response.status_code == 201, response.content
    payload = response.json()
    assert len(payload) == 1
    stored = GenericFile.objects.get(id=payload[0]["id"])
    assert stored.access == expected
    assert payload[0]["access"] == expected
    # The URL the endpoint hands back is the one the level implies.
    assert payload[0]["url"] == stored.get_url()
    prefix = "/uploadz/public/" if expected == "public" else "/uploadz/"
    assert payload[0]["url"].startswith(prefix)
    if expected != "public":
        assert not payload[0]["url"].startswith("/uploadz/public/")


@pytest.mark.django_db
@pytest.mark.parametrize("requested,expected", [
    (None, "public"),
    ("members", "members"),
    ("private", "private"),
])
def test_single_public_upload_is_not_actually_public_only(
        client, creator_factory, requested, expected):
    """
    `POST /uploads/single-public` is named for the level it defaults to, not
    the level it enforces: `access` is a writable serializer field here too,
    so this route will store a `private` row and return its `/uploadz/` URL.

    Recorded rather than changed — it is the CORRECT behaviour under "one
    asset, one level" (a route that forced `public` would be the thing that
    creates a wrongly-levelled row), but the NAME says otherwise, and a name
    that contradicts the behaviour is how a caller ends up assuming a
    guarantee that is not there.
    """
    creator = creator_factory(username=f"single-{requested}")
    client.force_login(creator)

    data = {"title": "pic", "name": "pic.png", "file": _upload()}
    if requested is not None:
        data["access"] = requested

    response = client.post(reverse("uploads_single_public"), data)

    assert response.status_code == 201, response.content
    payload = response.json()
    stored = GenericFile.objects.get(id=payload["id"])
    assert stored.access == expected
    #...and its auto-generated thumbnail follows the same level, rather than
    # being published at the public prefix beside a restricted original.
    assert stored.webp.get_url() == payload["thumbnail"]
    prefix = "/uploadz/public/" if expected == "public" else "/uploadz/"
    assert payload["thumbnail"].startswith(prefix)
    assert payload["url"].startswith(prefix)


@pytest.mark.django_db
def test_the_generic_create_route_refuses_and_writes_nothing(
        client, creator_factory):
    """`POST /api/myuploads/` is the fifth candidate creation path; it is
    closed, and it must stay a route that creates NO row."""
    creator = creator_factory(username="no-generic-create")
    client.force_login(creator)
    before = GenericFile.objects.count()

    response = client.post(
        "/api/myuploads/",
        data={"title": "x", "access": "public"},
        content_type="application/json",
    )

    assert response.status_code == 400
    assert GenericFile.objects.count() == before


# --------------------------------------------------------------------------
# no copies
# --------------------------------------------------------------------------

@pytest.mark.django_db
def test_no_creation_path_takes_its_level_from_another_row(creator_factory):
    """
    The "never a copy at a different level" invariant, stated over the
    enumeration: not one construction site passes `access=`, and not one
    builds its `file=` out of another row.

    The ONE exception to "no site passes `access=`" is the Dyte recording
    downloader, which derives the tier from the recording's
    `CreatorMeeting.meeting_type`. That is intentional and fail-closed
    (unknown -> private), so it is allowed `<dynamic>` as long as it does NOT
    also carry `+COPIES-BYTES` — deriving a level is not the same as copying
    another row's bytes, and the latter stays banned everywhere.

    Be precise about what that does and does not prove (adversarial review,
    finding 4). It proves no enumerated site reuses another row's bytes — the
    syntactic shape of 's re-upload. It cannot prove the absence of a
    copy that fetches the source bytes some other way (re-downloading its own
    URL, say); no static check can, which is why
    `test_switching_a_level_never_creates_a_second_row` in
    `test_access_matrix.py` drives the level-change API for real and asserts
    the row count is unchanged.

    Together those close  item 4 for the backend as far as it can be
    closed: the only way a level changes is an UPDATE to one row, and every
    way a row is born is an upload or a generated image (or a recording at the
    tier its meeting implies).
    """
    assert CONSTRUCTION_SITES == _construction_sites()
    tokens = [t for calls in CONSTRUCTION_SITES.values() for t in calls]
    assert tokens
    # NO site may copy another row's bytes.
    assert all(
        token is None or "+COPIES-BYTES" not in token for token in tokens
    ), (
        "A GenericFile construction site now builds its file from another "
        "row — the #1448 copy shape. It needs review here."
    )
    # AND at most the single intentional recording-downloader site may pass an
    # explicit (dynamic) access=.
    dynamic = [t for t in tokens if t != "<dynamic>" and t is not None]
    assert not dynamic, (
        "A GenericFile construction site now passes an explicit access= that "
        "is not the intentional recording-downloader '<dynamic>'. A literal "
        "level is not automatically wrong, but it needs review here."
    )


@pytest.mark.django_db
def test_setting_an_avatar_references_a_row_it_does_not_copy(
        client, creator_factory):
    """
    The profile write path (`PATCH /api/auth/user/`) is the busiest consumer
    of an upload, and 's bug was a consumer making its own copy.

    It cannot: `avatar_image` / `banner_image` are `PrimaryKeyRelatedField`s
    whose queryset is narrowed to `GenericFile.objects.filter(owner=user)` in
    `CreatorProfileUpdateSerializer.__init__`. So the write selects an
    EXISTING row of the caller's own and creates nothing — and someone else's
    id is rejected rather than copied.

    It also refuses a non-`public` row outright
    (`validate_avatar_image`). That refusal is the CORRECT half of the
     pattern: the consumer declines rather than minting a public
    duplicate. Its cost is recorded in
    `test_a_reference_survives_the_demotion_of_the_thing_it_references`.
    """
    creator = creator_factory(username="avatar-owner")
    other = creator_factory(username="avatar-stranger")
    mine = GenericFile.objects.create(
        owner=creator,
        file=ContentFile(_png_bytes(), name="mine.png"),
        mime_type="image/png",
        access="public",
    )
    mine_private = GenericFile.objects.create(
        owner=creator,
        file=ContentFile(_png_bytes(), name="mine-private.png"),
        mime_type="image/png",
        access="private",
    )
    theirs = GenericFile.objects.create(
        owner=other,
        file=ContentFile(_png_bytes(), name="theirs.png"),
        mime_type="image/png",
        access="public",
    )
    before = GenericFile.objects.count()

    client.force_login(creator)
    ok = client.patch(
        "/api/auth/user/",
        data={"avatar_image": mine.pk},
        content_type="application/json",
    )
    assert ok.status_code == 200, ok.content

    creator.refresh_from_db()
    assert creator.avatar_image_id == mine.pk
    # No copy, and the referenced row keeps the level it had.
    assert GenericFile.objects.count() == before
    mine.refresh_from_db()
    assert mine.access == "public"

    # A private upload of the caller's own is refused, NOT re-levelled and
    # NOT duplicated. This is the invariant  broke on the editor side.
    for candidate in (mine_private, theirs):
        refused = client.patch(
            "/api/auth/user/",
            data={"avatar_image": candidate.pk},
            content_type="application/json",
        )
        assert refused.status_code == 400, refused.content
        assert GenericFile.objects.count() == before
        creator.refresh_from_db()
        assert creator.avatar_image_id == mine.pk
    mine_private.refresh_from_db()
    assert mine_private.access == "private"


@pytest.mark.django_db
def test_a_reference_survives_the_demotion_of_the_thing_it_references(
        client, creator_factory):
    """
     hazard 4, reproduced on the backend and left as a finding.

    `validate_avatar_image` enforces `access == "public"` **at write time
    only**. Nothing re-checks it when the level later moves, and the level is
    freely movable by design. So:

      1. set a `public` upload as the avatar — accepted;
      2. `PATCH /api/myuploads/<id>/` it to `private` — accepted, and the
         media dashboard offers exactly this;
      3. the avatar reference is still there, now pointing at a row whose
         only URL is `/uploadz/<name>`, which answers 401 to every visitor.

    It fails CLOSED — a broken image, not a leak, and the serve path is
    behaving exactly as it should. But the write path accepted a state its
    own validator would reject, and nothing anywhere can enumerate the
    references that a demotion just broke. Recorded, not fixed: the fix is a
    product decision (block the demotion? clear the reference? warn?), and
    the frontend half of it is another agent's scope.

    **Every status below is the ORIGIN's answer, which is not the last word**
    (adversarial review, finding 2;  hazard 2). `/uploadz/public/...`
    carries `s-maxage=3600` and Cloud CDN serves a fresh cached object
    WITHOUT issuing the auth subrequest at all, so an anonymous fetch before
    the demotion keeps being served from the edge for up to an hour after
    these 401s begin — and per  the Cloud Build SA still lacks
    `compute.urlMaps.*`, so the invalidation half has never actually run.
    Nothing in CI can observe that; taking bytes down is two steps and only
    the first one is code. See `_public_access_ok`'s docstring in `views.py`.
    """
    creator = creator_factory(username="demotion-owner")
    visitor = creator_factory(username="demotion-visitor")
    avatar = GenericFile.objects.create(
        owner=creator,
        file=ContentFile(_png_bytes(), name="avatar.png"),
        mime_type="image/png",
        access="public",
    )

    client.force_login(creator)
    assert client.patch(
        "/api/auth/user/",
        data={"avatar_image": avatar.pk},
        content_type="application/json",
    ).status_code == 200

    public_url = avatar.get_url()
    assert public_url.startswith("/uploadz/public/")
    client.logout()
    assert client.get(
        reverse("uploads_auth_public"), HTTP_X_ORIGINAL_URI=public_url,
    ).status_code == 200

    # Demote it. The dashboard's own endpoint, no special pleading.
    client.force_login(creator)
    demote = client.patch(
        f"/api/myuploads/{avatar.pk}/",
        data={"access": "private"},
        content_type="application/json",
    )
    assert demote.status_code == 200, demote.content

    creator.refresh_from_db()
    avatar.refresh_from_db()
    # The reference is untouched...
    assert creator.avatar_image_id == avatar.pk
    assert avatar.access == "private"
    #...the URL moved...
    private_url = avatar.get_url()
    assert private_url.startswith("/uploadz/")
    assert not private_url.startswith("/uploadz/public/")
    #...the old URL is dead AT THE ORIGIN for everyone, the owner included
    # (the edge may still be serving it — see the docstring)...
    for user in (None, creator, visitor):
        if user is None:
            client.logout()
        else:
            client.force_login(user)
        assert client.get(
            reverse("uploads_auth_public"), HTTP_X_ORIGINAL_URI=public_url,
        ).status_code == 401
    #...and the new one is owner-only, so every visitor sees a broken avatar.
    client.logout()
    assert client.get(
        reverse("uploads_auth"), HTTP_X_ORIGINAL_URI=private_url,
    ).status_code == 401
    client.force_login(visitor)
    assert client.get(
        reverse("uploads_auth"), HTTP_X_ORIGINAL_URI=private_url,
    ).status_code == 401
    client.force_login(creator)
    assert client.get(
        reverse("uploads_auth"), HTTP_X_ORIGINAL_URI=private_url,
    ).status_code == 200
