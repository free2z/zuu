"""
One time script to bootstrap events for existing users
"""
from django.core.management.base import BaseCommand
from django.contrib.contenttypes.models import ContentType

from dj.apps.events.models import Event
from dj.apps.g12f.models import zPage
from dj.apps.comments.models import Comment


class Command(BaseCommand):
    def handle(self, *args, **options):
        # PAGE_UPDATE
        print("Creating PAGE_UPDATE events")
        for zp in zPage.objects.filter(is_published=True):
            content_type = ContentType.objects.get_for_model(zp)
            object_id = zp.id
            for fan in zp.creator.get_fans():
                try:
                    Event.objects.get_or_create(
                        type='PAGE_UPDATE',
                        receiving_user=fan,
                        contributor=zp.creator,
                        content_type=content_type,
                        object_id=object_id,
                    )
                except Event.MultipleObjectsReturned:
                    continue

        print("Creating NEW_REPLY events")
        for comment in Comment.objects.all():
            # sent = False
            content_type = ContentType.objects.get_for_model(comment)
            object_id = comment.uuid
            if comment.parent:
                try:
                    Event.objects.get_or_create(
                        type='NEW_REPLY',
                        # content_object=comment.content_object,
                        receiving_user=comment.parent.author,
                        contributor=comment.author,
                        content_type=content_type,
                        object_id=object_id,
                    )
                except Event.MultipleObjectsReturned:
                    pass
                sent = True
            if comment.content_object and not sent:
                try:
                    Event.objects.get_or_create(
                        type='NEW_REPLY',
                        # content_object=comment.content_object,
                        # can only be a zpage right now
                        receiving_user=comment.content_object.creator,
                        contributor=comment.author,
                        content_type=content_type,
                        object_id=object_id,
                    )
                except Event.MultipleObjectsReturned:
                    pass
                sent = True

            for fan in comment.author.get_fans():
                try:
                    Event.objects.get_or_create(
                        type='NEW_REPLY',
                        # content_object=comment.content_object,
                        receiving_user=fan,
                        contributor=comment.author,
                        content_type=content_type,
                        object_id=object_id,
                    )
                except Event.MultipleObjectsReturned:
                    pass

        print("Creating NEW_COMMENT events")
