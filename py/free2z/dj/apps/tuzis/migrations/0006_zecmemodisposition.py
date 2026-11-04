from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tuzis', '0005_providerreservation'),
    ]

    operations = [
        migrations.CreateModel(
            name='ZecMemoDisposition',
            fields=[
                (
                    'id',
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name='ID',
                    ),
                ),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('txid', models.CharField(max_length=64)),
                ('pool', models.CharField(blank=True, default='', max_length=16)),
                ('output_index', models.PositiveIntegerField(default=0)),
                ('amount_zec', models.DecimalField(decimal_places=8, max_digits=18)),
                (
                    'classification',
                    models.CharField(
                        choices=[
                            ('unparseable_buy_2z', 'Unparseable buy_2z memo'),
                        ],
                        default='unparseable_buy_2z',
                        editable=False,
                        max_length=32,
                    ),
                ),
                (
                    'decision',
                    models.CharField(
                        choices=[
                            ('credited_manually', 'Credited manually'),
                            ('not_purchase', 'Not a purchase'),
                            ('ignore', 'Ignore'),
                        ],
                        blank=True,
                        null=True,
                        max_length=24,
                    ),
                ),
                ('operator', models.CharField(blank=True, default='', max_length=128)),
                ('reason', models.TextField(blank=True, default='')),
                ('disposed_at', models.DateTimeField(blank=True, null=True)),
            ],
            options={
                'ordering': ['-created_at'],
                'indexes': [
                    models.Index(
                        fields=['decision', 'created_at'],
                        name='zec_memo_disp_decision_idx',
                    ),
                ],
                'constraints': [
                    models.UniqueConstraint(
                        fields=('txid', 'pool', 'output_index'),
                        name='unique_zec_memo_disposition_per_note',
                    ),
                    models.CheckConstraint(
                        condition=models.Q(('amount_zec__gt', 0)),
                        name='zec_memo_disposition_positive_amount',
                    ),
                ],
            },
        ),
    ]
