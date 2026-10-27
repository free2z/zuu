"""Refuse rate cards that charge images separately for token-billed models (#2232)."""
from django.db import migrations


GUARD_SQL = r"""
CREATE FUNCTION pricing_ratecard_token_image_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    -- A rate row is keyed by the public model ID, so resolve its provider at
    -- publication/activation. Keep the existing escape hatch to deactivate a
    -- card even if model metadata was changed after it was published.
    IF (TG_OP = 'INSERT' AND (NEW.published_at IS NOT NULL OR NEW.active))
       OR (TG_OP = 'UPDATE' AND OLD.published_at IS NULL AND NEW.published_at IS NOT NULL)
       OR (TG_OP = 'UPDATE' AND NOT OLD.active AND NEW.active) THEN
        IF EXISTS (
            SELECT 1
              FROM pricing_ratecard_model AS rate
              JOIN openai_aimodel AS model ON model.model = rate.model_id
             WHERE rate.rate_card_id = NEW.id
               AND rate.image_nusd > 0
               AND model.provider IN ('openai', 'anthropic')
        ) THEN
            RAISE EXCEPTION
                'pricing_ratecard v% has a per-image price for an OpenAI or Anthropic model',
                NEW.version
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER pricing_ratecard_token_image_guard
    BEFORE INSERT OR UPDATE OF published_at, active ON pricing_ratecard
    FOR EACH ROW EXECUTE FUNCTION pricing_ratecard_token_image_guard();
"""

REVERSE_GUARD_SQL = r"""
DROP TRIGGER IF EXISTS pricing_ratecard_token_image_guard ON pricing_ratecard;
DROP FUNCTION IF EXISTS pricing_ratecard_token_image_guard();
"""


class Migration(migrations.Migration):

    dependencies = [
        ('openai', '0021_aimodel_signed_capabilities'),
        ('pricing', '0004_seed_rate_card_v2'),
    ]

    operations = [
        migrations.RunSQL(GUARD_SQL, REVERSE_GUARD_SQL),
    ]
