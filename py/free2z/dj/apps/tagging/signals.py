from django.db import IntegrityError, OperationalError, ProgrammingError, transaction
from django.db.models.signals import post_save
from django.dispatch import receiver

from taggit.models import Tag

from .models import TagIdentity, tag_key
from .slugs import slugify_tag


@receiver(post_save, sender=Tag, dispatch_uid="tagging.sync_tag_identity")
def sync_tag_identity(sender, instance, **kwargs):
    """Best-effort fast path; reads never trust this projection by itself.

    ``raw=True`` is used by fixtures and data-loading tools.  It must not
    overwrite a projection with half-loaded historical state.  The retry also
    closes the ordinary ``update_or_create`` insert race with a concurrent
    bulk/import writer.  During a rolling deploy the receiver may run before
    migration 0003 has created its table; the missing-table case is explicitly
    tolerated and the authoritative read/repair path catches up later.
    """
    if kwargs.get("raw"):
        return
    defaults = {
        "name_key": tag_key(instance.name),
        "slug": slugify_tag(instance.name),
    }
    try:
        with transaction.atomic():
            TagIdentity.objects.update_or_create(
                tag_id=instance.pk, defaults=defaults
            )
    except IntegrityError:
        TagIdentity.objects.filter(tag_id=instance.pk).update(**defaults)
    except (OperationalError, ProgrammingError) as exc:
        # New application code can be rolled out before the schema migration.
        # Do not hide unrelated database failures: only the known missing-table
        # transition is safe to defer.
        message = str(exc).lower()
        if "tagging_tagidentity" not in message:
            raise
