"""Make ``Comment.headline`` optional and blank the placeholder sentinels.

Issues #440 / #531. ``headline`` was a required ``CharField``, so every UI had
to send *something* for a plain comment or a reply. The new UI sent the literal
string ``"N/A"`` and the classic React UI's reply flow sent ``"re"``. Those
sentinels are real data: the classic UI renders ``comment.headline`` as the card
title, so a comment posted from the new UI literally displays "N/A" there, and
the auto-tweet pipeline builds AI-image prompts titled ``"<page>, N/A"``.

Two operations:

1. ``AlterField`` — headline becomes ``blank=True, default=''``. DRF derives
   ``required=False, allow_blank=True`` from that, so clients may simply omit it.
2. ``RunPython`` — blank the existing sentinels. The match is deliberately
   narrow: case-insensitive *exact* equality against a short allow-list, so a
   genuine headline that merely contains "n/a" is untouched. The only loss is a
   comment whose author really did title it exactly "re" or "N/A", which carries
   no information anyway.

Reverse re-fills blanks with "N/A" rather than being a no-op: it cannot know
which blanks were originally sentinels, but it does restore a state the old
required-headline schema and the old UIs accept.
"""
from django.db import migrations, models
from django.db.models import Q

# Matched case-insensitively and *exactly* — see the module docstring.
PLACEHOLDERS = ('n/a', 're')


def blank_placeholder_headlines(apps, schema_editor):
    Comment = apps.get_model('comments', 'Comment')
    match = Q()
    for placeholder in PLACEHOLDERS:
        match |= Q(headline__iexact=placeholder)
    Comment.objects.filter(match).update(headline='')


def restore_placeholder_headlines(apps, schema_editor):
    """Re-fill blanks so the pre-#440 required-headline schema stays valid."""
    Comment = apps.get_model('comments', 'Comment')
    Comment.objects.filter(headline='').update(headline='N/A')


class Migration(migrations.Migration):
    dependencies = [
        ('comments', '0005_alter_uuidtaggeditem_content_type_and_more'),
    ]

    operations = [
        migrations.AlterField(
            model_name='comment',
            name='headline',
            field=models.CharField(blank=True, default='', max_length=100),
        ),
        migrations.RunPython(
            blank_placeholder_headlines,
            restore_placeholder_headlines,
        ),
    ]
