"""AI rate cards: ``pricing_ratecard`` + ``pricing_ratecard_model`` (#2222).

docs/tuzis/ledger-v2.md §9. ADDITIVE ONLY: two new tables nothing reads yet,
so an old pod (which has never heard of them) behaves exactly as before and a
code rollback is a no-op.

IMMUTABLE ONCE PUBLISHED is enforced here, in Postgres, not in ``save()``:
``QuerySet.update()``, raw SQL and the ledger's own functions all bypass
``save()``, and a hold that snapshotted a card must be settled on exactly the
numbers it was admitted under. The triggers:

* ``pricing_ratecard``: a published row (``published_at IS NOT NULL``) may
  change ``active`` and nothing else -- compared as the whole row minus
  ``active``, so columns added later are frozen too; it can never be
  un-published or deleted. A draft may be edited, published, or deleted
  freely. A card cannot become active while it has no model rows.
* ``pricing_ratecard_model``: no INSERT, UPDATE or DELETE of a row whose card
  (old or new) is published. Editing prices means publishing a new version.

Publishing is ``UPDATE pricing_ratecard SET published_at = now()`` on a draft;
the model rows it carries at that instant are the card, forever.

WHAT THESE DO NOT STOP, deliberately:

* ``TRUNCATE`` fires no row trigger. Only the table owner can issue it, no
  application code does, and the test suite's ``transactional_db`` flush
  relies on it (a trigger on it would make every such test fail teardown).
* The table owner can ``ALTER TABLE ... DISABLE TRIGGER``. These guard
  against ACCIDENTS -- an ORM ``.update()``, a stray admin action, a raw
  UPDATE in a psql session at 3am -- not against the owner, who could just as
  well drop the table. Doing that on prod is an incident, not an edit.

Both run on PG14 (prod) and PG16 (CI): plain PL/pgSQL row triggers.
"""
import django.db.models.deletion
from django.db import migrations, models


TRIGGERS_SQL = r"""
CREATE FUNCTION pricing_ratecard_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.published_at IS NOT NULL THEN
            RAISE EXCEPTION 'pricing_ratecard v% is published and cannot be deleted', OLD.version
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN OLD;
    END IF;
    -- UPDATE of a published card: every column except "active" is frozen.
    -- Compared as whole rows (jsonb minus "active"), not column by column,
    -- so a column added by a later migration is frozen too without anyone
    -- remembering to extend this list.
    IF TG_OP = 'UPDATE' AND OLD.published_at IS NOT NULL THEN
        IF (to_jsonb(NEW) - 'active') IS DISTINCT FROM (to_jsonb(OLD) - 'active') THEN
            RAISE EXCEPTION 'pricing_ratecard v% is published; only "active" may change', OLD.version
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END IF;
    -- A card that becomes active must carry at least one model: an active
    -- empty card would admit holds that every model then fails as
    -- unknown_rate_card. (INSERT: a new row can have no model rows yet.)
    IF NEW.active AND (TG_OP = 'INSERT' OR NOT OLD.active) THEN
        IF TG_OP = 'INSERT' OR NOT EXISTS (
            SELECT 1 FROM pricing_ratecard_model WHERE rate_card_id = NEW.id
        ) THEN
            RAISE EXCEPTION 'pricing_ratecard v% has no model rows and cannot be activated', NEW.version
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER pricing_ratecard_guard
    BEFORE INSERT OR UPDATE OR DELETE ON pricing_ratecard
    FOR EACH ROW EXECUTE FUNCTION pricing_ratecard_guard();

CREATE FUNCTION pricing_ratecard_model_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_published timestamptz;
BEGIN
    -- The card row is locked FOR SHARE UNCONDITIONALLY (a draft too): that
    -- is what serialises this write against a concurrent publish. A publish
    -- that commits first is seen here (READ COMMITTED re-reads the locked
    -- row); a publish that starts after us waits for our commit and then
    -- carries our row. Checking only published cards would lock nothing on
    -- a draft and let a row slip onto a card published in between.
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        SELECT published_at INTO v_published FROM pricing_ratecard
         WHERE id = OLD.rate_card_id FOR SHARE;
        IF v_published IS NOT NULL THEN
            RAISE EXCEPTION 'pricing_ratecard_model %: rate card % is published and immutable',
                OLD.model_id, OLD.rate_card_id
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        SELECT published_at INTO v_published FROM pricing_ratecard
         WHERE id = NEW.rate_card_id FOR SHARE;
        IF v_published IS NOT NULL THEN
            RAISE EXCEPTION 'pricing_ratecard_model %: rate card % is published and immutable',
                NEW.model_id, NEW.rate_card_id
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER pricing_ratecard_model_guard
    BEFORE INSERT OR UPDATE OR DELETE ON pricing_ratecard_model
    FOR EACH ROW EXECUTE FUNCTION pricing_ratecard_model_guard();
"""

REVERSE_TRIGGERS_SQL = r"""
DROP TRIGGER IF EXISTS pricing_ratecard_model_guard ON pricing_ratecard_model;
DROP FUNCTION IF EXISTS pricing_ratecard_model_guard();
DROP TRIGGER IF EXISTS pricing_ratecard_guard ON pricing_ratecard;
DROP FUNCTION IF EXISTS pricing_ratecard_guard();
"""


class Migration(migrations.Migration):

    dependencies = [
        ('pricing', '0001_initial'),
    ]

    operations = [
        migrations.CreateModel(
            name='RateCard',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('version', models.PositiveBigIntegerField(help_text="Monotonic rate-card version (the catalogue's rate_card_version, a u64). Captured on every ledger hold; settle prices on it.", unique=True)),
                ('platform_margin_bps', models.PositiveIntegerField(db_default=2000, default=2000, help_text='Platform margin in basis points (2000 = 20 %).')),
                ('min_margin_bps', models.PositiveIntegerField(db_default=0, default=0, help_text='Floor the platform margin on this card may not go below (CHECK platform_margin_bps >= min_margin_bps).')),
                ('active', models.BooleanField(db_default=False, default=False, help_text='May a NEW hold be admitted on this card? Only a published card can be active. More than one may be active during a rotation.')),
                ('published_at', models.DateTimeField(blank=True, help_text='Set once, when the card is published. From then on the card and its model rows are immutable (DB trigger); only `active` moves.', null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
            ],
            options={
                'db_table': 'pricing_ratecard',
                'ordering': ['-version'],
                'constraints': [models.CheckConstraint(condition=models.Q(('version__gte', 1)), name='pricing_ratecard_version_positive'), models.CheckConstraint(condition=models.Q(('platform_margin_bps__gte', models.F('min_margin_bps'))), name='pricing_ratecard_margin_at_least_min'), models.CheckConstraint(condition=models.Q(('platform_margin_bps__lte', 100000)), name='pricing_ratecard_margin_sane'), models.CheckConstraint(condition=models.Q(('active', False), ('published_at__isnull', False), _connector='OR'), name='pricing_ratecard_active_requires_published')],
            },
        ),
        migrations.CreateModel(
            name='RateCardModel',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('model_id', models.CharField(max_length=200)),
                ('input_nusd_per_mtok', models.PositiveBigIntegerField()),
                ('cached_input_nusd_per_mtok', models.PositiveBigIntegerField()),
                ('cache_write_5m_nusd_per_mtok', models.PositiveBigIntegerField()),
                ('cache_write_1h_nusd_per_mtok', models.PositiveBigIntegerField()),
                ('output_nusd_per_mtok', models.PositiveBigIntegerField()),
                ('image_nusd', models.PositiveBigIntegerField()),
                ('tool_call_nusd', models.PositiveBigIntegerField()),
                ('min_charge_2z', models.PositiveIntegerField(default=1, help_text='Minimum charge per call, whole 2Z. Never below 1 (CHECK).')),
                ('rate_card', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='model_rows', to='pricing.ratecard')),
            ],
            options={
                'db_table': 'pricing_ratecard_model',
                'ordering': ['rate_card', 'model_id'],
                'constraints': [models.UniqueConstraint(fields=('rate_card', 'model_id'), name='pricing_ratecard_model_unique'), models.CheckConstraint(condition=models.Q(('min_charge_2z__gte', 1)), name='pricing_ratecard_model_min_charge_2z_gte_1'), models.CheckConstraint(condition=models.Q(('model_id', ''), _negated=True), name='pricing_ratecard_model_id_nonempty'), models.CheckConstraint(condition=models.Q(('input_nusd_per_mtok__gt', 0), ('cached_input_nusd_per_mtok__gt', 0), ('cache_write_5m_nusd_per_mtok__gt', 0), ('cache_write_1h_nusd_per_mtok__gt', 0), ('output_nusd_per_mtok__gt', 0), ('image_nusd__gt', 0), ('tool_call_nusd__gt', 0), _connector='OR'), name='pricing_ratecard_model_not_all_zero')],
            },
        ),
        migrations.RunSQL(TRIGGERS_SQL, REVERSE_TRIGGERS_SQL),
    ]
