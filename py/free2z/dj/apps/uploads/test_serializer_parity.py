"""The two upload serializers must answer the same shape.

``POST /uploads/handle`` and ``/uploads/single-public`` answer with
``GenericFileSerializer``; ``/api/myuploads/`` (and every nested
``avatar_image`` / ``banner_image`` / ``featured_image``) answers with
``FeaturedImageSerializer``. ``f2z.yaml`` documents the upload routes with the
``FeaturedImage`` component, so the generated clients believe they are one
shape. Today they are: the same 15 fields, the same types, the same
read-only set. But they are two classes, and nothing stopped one from
gaining a field the other lacks. This pins them together.

Negative control: add ``'owner'`` to either class's ``fields`` (or drop
``'poster'``), and ``test_same_fields_types_and_read_only_set`` and
``test_same_output_for_the_same_row`` both go red.
"""
from io import BytesIO

import pytest
from PIL import Image

from django.core.files.base import ContentFile

from dj.apps.uploads.models import GenericFile
from dj.apps.uploads.serializers import (
    FeaturedImageSerializer, GenericFileSerializer,
)


@pytest.fixture(autouse=True)
def _local_media(settings, tmp_path):
    """Swap GCS for a tmp dir -- the external storage boundary only."""
    settings.STORAGES = {
        **settings.STORAGES,
        "default": {
            "BACKEND": "django.core.files.storage.FileSystemStorage",
        },
    }
    settings.MEDIA_ROOT = str(tmp_path)


def _png_bytes():
    out = BytesIO()
    Image.new("RGB", (8, 8), (10, 120, 200)).save(out, format="PNG")
    return out.getvalue()


def _field_signature(serializer_class):
    fields = serializer_class().get_fields()
    return {
        name: (type(field).__name__, field.read_only, field.required,
               getattr(field, "allow_null", False))
        for name, field in fields.items()
    }


def test_same_fields_types_and_read_only_set():
    generic = _field_signature(GenericFileSerializer)
    featured = _field_signature(FeaturedImageSerializer)
    assert set(generic) == set(featured), sorted(set(generic) ^ set(featured))
    differing = {
        name: (generic[name], featured[name])
        for name in generic if generic[name] != featured[name]
    }
    assert differing == {}


@pytest.mark.django_db
@pytest.mark.parametrize("name, mime, access", [
    ("pic.png", "image/png", "public"),
    ("notes.pdf", "application/pdf", "private"),
])
def test_same_output_for_the_same_row(creator_factory, name, mime, access):
    owner = creator_factory()
    row = GenericFile.objects.create(
        owner=owner,
        file=ContentFile(_png_bytes(), name=name),
        mime_type=mime,
        access=access,
        title="t",
        description="d",
    )
    generic = dict(GenericFileSerializer(row).data)
    featured = dict(FeaturedImageSerializer(row).data)
    assert generic == featured
