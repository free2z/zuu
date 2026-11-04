"""Creator profile dates on the detail API.

The new-ui profile route emits a ProfilePage JSON-LD block whose `mainEntity`
Google recommends carry `dateCreated`.  shipped the ProfilePage/
`mainEntity` fix without it, because the timestamp was not exposed by
`CreatorDetailSerializer` -- the field already existed on the model
(`date_joined` from Django's `AbstractUser`), so this only needed a
serializer change, no migration.

`updated_at` (also already on the model, via `Creator.updated_at`) is
deliberately NOT exposed here, even though Google recommends a
`dateModified` too: it advances on ANY save of the row, including private
security operations that have nothing to do with the public profile --
`CreatorSetPasswordForm.save()` bumps it on every password change. Exposing
it on this anonymous, unauthenticated endpoint would let anyone poll a
creator's public profile to learn the exact moment of their last account
change of any kind (codex adversarial review, escalated across two
independent passes). `date_modified` instead comes from a dedicated nullable
timestamp written only when a public profile field changes. Both public dates
are returned at calendar-day precision; existing accounts without a known
profile edit remain null rather than receiving an inferred historical date.

`date_joined` itself remains exposed at DAY precision, not as a full timestamp,
for the same reason: on an anonymous, unauthenticated endpoint the exact
instant of signup is a correlation handle. The frontend's JSON-LD consumer
represents that day as UTC midnight to satisfy Google's DateTime parser; it
does not restore the signup instant.
"""
import datetime
from decimal import Decimal

import pytest
from django.core.files.base import ContentFile

from dj.apps.g12f.models.creator import Creator
from dj.apps.uploads.models import GenericFile


@pytest.fixture(autouse=True)
def _local_media(settings, tmp_path):
    settings.STORAGES = {
        **settings.STORAGES,
        "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    }
    settings.MEDIA_ROOT = str(tmp_path)


def _detail(api_client, username):
    return api_client.get(f"/api/creator/{username}/")


@pytest.mark.django_db
def test_creator_detail_exposes_date_joined(api_client, creator_factory):
    creator = creator_factory(username="datedcreator")

    response = _detail(api_client, "datedcreator")

    assert response.status_code == 200
    body = response.json()
    assert "date_joined" in body
    # The public API contract is an ISO-8601 calendar date. The frontend
    # expands it to UTC midnight only in ProfilePage JSON-LD; the API must not
    # disclose the signup instant.
    assert datetime.date.fromisoformat(body["date_joined"]) == creator.date_joined.date()


@pytest.mark.django_db
def test_date_joined_is_day_precision_not_an_instant(api_client, creator_factory):
    # Day precision, deliberately. This is
    # the same anonymous, unauthenticated endpoint the `updated_at` decision
    # above turns on: `dateCreated` needs nothing finer than a day, and the
    # exact instant of signup is a correlation handle -- it joins the profile
    # to whatever else happened in that second. A full timestamp is not a
    # richer answer to the same question, it is a different disclosure.
    creator = creator_factory(username="precisecreator")
    # A distinctive time-of-day, so a truncation that silently stopped
    # happening cannot pass by coincidence.
    stamp = datetime.datetime(2026, 3, 4, 5, 6, 7, 891234, tzinfo=datetime.timezone.utc)
    Creator.objects.filter(pk=creator.pk).update(date_joined=stamp)

    value = _detail(api_client, "precisecreator").json()["date_joined"]

    assert value == "2026-03-04"
    # Nothing about the time of day survives -- not a `T`, not an offset, not
    # a zero-filled clock that would still pin the day boundary in another
    # timezone.
    assert "T" not in value
    assert ":" not in value


@pytest.mark.django_db
def test_creator_detail_does_not_expose_updated_at(api_client, creator_factory):
    # Regression guard for the disclosure above: `updated_at` must stay off
    # this anonymous endpoint even if a future edit re-adds it to the
    # serializer's field list without re-reading why it was removed.
    creator_factory(username="privatecreator")

    body = _detail(api_client, "privatecreator").json()

    assert "updated_at" not in body


@pytest.mark.django_db
def test_date_modified_tracks_changed_public_profile_fields(
        api_client, creator_factory):
    creator = creator_factory(username="profile-date-modified")
    api_client.force_authenticate(user=creator)

    initial = _detail(api_client, "profile-date-modified").json()
    assert initial["date_modified"] is None

    spoofed = api_client.patch(
        "/api/auth/user/",
        {
            "date_modified": "2000-01-01",
            "public_profile_updated_at": "2000-01-01T00:00:00Z",
        },
        format="json",
    )
    assert spoofed.status_code == 200, spoofed.content
    creator.refresh_from_db()
    assert creator.public_profile_updated_at is None
    creator.public_profile_updated_at = datetime.datetime.now(
        datetime.timezone.utc,
    )
    with pytest.raises(ValueError, match="database and cannot be assigned"):
        creator.save(update_fields=["public_profile_updated_at"])

    updated = api_client.patch(
        "/api/auth/user/", {"description": "A public profile edit"},
        format="json",
    )

    assert updated.status_code == 200, updated.content
    creator.refresh_from_db()
    assert creator.public_profile_updated_at is not None
    body = _detail(api_client, "profile-date-modified").json()
    assert body["date_modified"] == creator.public_profile_updated_at.date().isoformat()
    assert "T" not in body["date_modified"]


@pytest.mark.parametrize(("field", "replacement"), [
    ("username", "profile-renamed"),
    ("full_name", "New public name"),
    ("description", "New public bio"),
    ("p2paddr", "public-address-change"),
    ("member_price", Decimal("22")),
])
@pytest.mark.django_db
def test_database_tracks_real_public_edits_and_ignores_noops(
        creator_factory, field, replacement):
    creator = creator_factory(
        username=f"tracked-{field}",
        full_name="Before",
        description="Before",
        p2paddr="before-address",
        member_price=Decimal("10"),
    )

    Creator.objects.filter(pk=creator.pk).update(**{field: replacement})
    creator.refresh_from_db()
    first_stamp = creator.public_profile_updated_at
    assert first_stamp is not None

    # QuerySet.update bypasses Creator.save() and the profile serializer. The
    # trigger still compares the persisted OLD and NEW values, and a same-value
    # write does not advance the public modification date.
    Creator.objects.filter(pk=creator.pk).update(**{field: replacement})
    creator.refresh_from_db()
    assert creator.public_profile_updated_at == first_stamp


def _image(owner, name):
    return GenericFile.objects.create(
        owner=owner,
        file=ContentFile(b"test image bytes", name=name),
        mime_type="image/png",
        access="public",
    )


@pytest.mark.parametrize("field", ["avatar_image", "banner_image"])
@pytest.mark.django_db
def test_image_replacement_noop_and_fk_deletion_track_public_change(
        creator_factory, field):
    creator = creator_factory(username=f"image-date-{field}")
    first = _image(creator, f"{field}-first.png")
    second = _image(creator, f"{field}-second.png")
    field_id = f"{field}_id"

    Creator.objects.filter(pk=creator.pk).update(**{field_id: first.pk})
    creator.refresh_from_db()
    first_stamp = creator.public_profile_updated_at
    assert first_stamp is not None

    Creator.objects.filter(pk=creator.pk).update(**{field_id: first.pk})
    creator.refresh_from_db()
    assert creator.public_profile_updated_at == first_stamp

    Creator.objects.filter(pk=creator.pk).update(**{field_id: second.pk})
    creator.refresh_from_db()
    replacement_stamp = creator.public_profile_updated_at
    assert replacement_stamp > first_stamp

    # Deleting the referenced upload causes PostgreSQL's ON DELETE SET NULL
    # action, which must pass through the same profile-change trigger.
    second.delete()
    creator.refresh_from_db()
    assert getattr(creator, field_id) is None
    assert creator.public_profile_updated_at > replacement_stamp


@pytest.mark.django_db
def test_transient_and_derived_creator_fields_do_not_change_profile_date(
        creator_factory):
    creator = creator_factory(username="profile-status-is-not-edit")

    Creator.objects.filter(pk=creator.pk).update(
        is_verified=True,
        email="private-contact@example.test",
        total=Decimal("3.25"),
    )

    creator.refresh_from_db()
    assert creator.public_profile_updated_at is None


@pytest.mark.django_db
def test_non_profile_writes_and_noop_profile_writes_do_not_move_date_modified(
        api_client, creator_factory):
    creator = creator_factory(username="stable-profile-date")
    api_client.force_authenticate(user=creator)
    changed = api_client.patch(
        "/api/auth/user/", {"description": "First edit"}, format="json",
    )
    assert changed.status_code == 200, changed.content
    creator.refresh_from_db()
    original = creator.public_profile_updated_at

    # Re-submitting an unchanged public field and changing a private/contact
    # field must not pretend the public profile itself changed.
    noop = api_client.patch(
        "/api/auth/user/", {"description": "First edit"}, format="json",
    )
    email = api_client.patch(
        "/api/auth/user/", {"email": "new-contact@example.test"},
        format="json",
    )

    assert noop.status_code == 200, noop.content
    assert email.status_code == 200, email.content
    creator.refresh_from_db()
    assert creator.public_profile_updated_at == original

    body = _detail(api_client, "stable-profile-date").json()
    assert body["date_modified"] == original.date().isoformat()


@pytest.mark.django_db
def test_date_joined_is_read_only(api_client, creator_factory):
    # `dateCreated` is a provenance claim; nothing about exposing it
    # on the detail GET should make it writable through the same serializer
    # on some other action.
    from dj.apps.g12f.serializers.creator import CreatorDetailSerializer

    serializer = CreatorDetailSerializer()
    assert serializer.fields["date_joined"].read_only is True
    assert serializer.fields["date_modified"].read_only is True


@pytest.mark.django_db
def test_password_change_cannot_move_a_stale_public_profile_timestamp(
        creator_factory):
    creator = creator_factory(username="stale-profile-date")
    stale = Creator.objects.only("password").get(pk=creator.pk)
    newer = Creator.objects.get(pk=creator.pk)
    newer.full_name = "A newer public edit"
    newer.save(update_fields=["full_name"])
    newer.refresh_from_db()
    public_edit = newer.public_profile_updated_at
    assert public_edit is not None

    # SetPasswordForm uses a full model save. A stale instance must preserve
    # the public edit timestamp while updating private credentials.
    stale.set_password("a-new-secret")
    stale.save()
    stale.refresh_from_db()

    assert stale.public_profile_updated_at == public_edit


@pytest.mark.django_db
def test_full_save_of_a_fully_loaded_instance_never_writes_its_stale_stamp(
        creator_factory):
    """The `.only("password")` case above defers the column, so it cannot
    tell whether a full save is kept off it. This instance carries EVERY
    column: a profile edit through `update_fields` stamps the row but not the
    instance, and the same instance's later full save (a password change in
    the same request) would otherwise write that stale NULL back with no
    public field changed -- which the trigger rejects, failing the request.
    """
    creator = creator_factory(username="full-stale-profile-date")
    user = Creator.objects.get(pk=creator.pk)
    user.full_name = "A public edit"
    user.save(update_fields=["full_name"])
    assert user.public_profile_updated_at is None  # in-memory value is stale
    stamped = Creator.objects.get(pk=creator.pk).public_profile_updated_at
    assert stamped is not None

    user.set_password("a-new-secret")
    user.save()

    user.refresh_from_db()
    assert user.public_profile_updated_at == stamped
    assert user.check_password("a-new-secret")


@pytest.mark.django_db
def test_stale_partial_profile_update_reverts_real_data_and_noop_preserves_stamp(
        creator_factory):
    creator = creator_factory(
        username="stale-profile-revert", description="original",
    )
    stale = Creator.objects.get(pk=creator.pk)
    current = Creator.objects.get(pk=creator.pk)
    current.description = "intervening public edit"
    current.full_name = "current name"
    current.save(update_fields=["description", "full_name"])
    current.refresh_from_db()
    intervening_stamp = current.public_profile_updated_at

    # This stale partial write is a real revert of description. The trigger
    # compares against the database row, not the caller's stale snapshot.
    stale.description = "original"
    stale.save(update_fields=["description"])
    stale.refresh_from_db()
    assert stale.description == "original"
    reverted_stamp = stale.public_profile_updated_at
    assert reverted_stamp > intervening_stamp

    # A fresh partial no-op leaves the timestamp byte-for-byte unchanged.
    current.refresh_from_db()
    current.save(update_fields=["description"])
    current.refresh_from_db()
    assert current.public_profile_updated_at == reverted_stamp
    assert current.full_name == "current name"
