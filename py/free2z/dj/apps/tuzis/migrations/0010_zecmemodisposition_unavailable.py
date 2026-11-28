from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('tuzis', '0009_subscription_intent_abandonment')]
    operations = [migrations.AlterField(
        model_name='zecmemodisposition', name='classification',
        field=models.CharField(max_length=32, editable=False, default='unparseable_buy_2z', choices=[
            ('transaction_unavailable', 'Transaction or memo unavailable'),
            ('unparseable_buy_2z', 'Unparseable buy_2z memo'),
            ('page_target_not_found', 'Page memo names a zPage that does not exist'),
            ('unparseable_page_memo', 'Unparseable page memo')]))]
