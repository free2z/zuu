from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('openai', '0013_alter_promptresponse_conversation'),
    ]

    operations = [
        migrations.AddField(
            model_name='aimodel',
            name='provider',
            field=models.CharField(
                choices=[
                    ('openai', 'OpenAI'),
                    ('anthropic', 'Anthropic'),
                    ('xai', 'xAI'),
                    ('kimi', 'Kimi (Moonshot)'),
                ],
                default='openai',
                help_text='Which AI provider serves this model.',
                max_length=32,
            ),
        ),
    ]
