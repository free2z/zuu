from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('events', '0015_alter_event_type'),
    ]

    operations = [
        migrations.AlterField(
            model_name='event',
            name='type',
            field=models.CharField(choices=[('AISCORE_COMMENT', 'AISCORE_COMMENT'), ('MADE_COMMENT', 'MADE_COMMENT'), ('VOTE_COMMENT_RECEIVED', 'VOTE_COMMENT_RECEIVED'), ('VOTE_COMMENT_SENT', 'VOTE_COMMENT_SENT'), ('NEW_REPLY', 'NEW_REPLY'), ('PAGE_UPDATE', 'PAGE_UPDATE'), ('PAGE_VOTE', 'PAGE_VOTE'), ('PAGE_MENTION', 'PAGE_MENTION'), ('DONATION_RECEIVED', 'DONATION_RECEIVED'), ('DONATION_SENT', 'DONATION_SENT'), ('SUBSCRIPTION_RECEIVED', 'SUBSCRIPTION_RECEIVED'), ('SUBSCRIPTION_SENT', 'SUBSCRIPTION_SENT'), ('BOUGHT_TUZI', 'BOUGHT_TUZI'), ('ZEC_PENDING', 'ZEC_PENDING'), ('CHAT2Z', 'CHAT2Z'), ('PLATFORM_FEE', 'PLATFORM_FEE'), ('PAY_PER_VIEW_REVENUE', 'PAY_PER_VIEW_REVENUE'), ('PAY_PER_VIEW_SPEND', 'PAY_PER_VIEW_SPEND'), ('ENCRYPTED_CHAT_REQUEST', 'ENCRYPTED_CHAT_REQUEST')], max_length=32),
        ),
    ]
