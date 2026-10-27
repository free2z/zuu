"""An inert, owner-activated fence against unjournaled legacy balance writes."""
from django.db import migrations, models

LOCKS = """
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public.g12f_creator IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.ledger_account IN ACCESS EXCLUSIVE MODE;
"""

SQL = r"""
CREATE FUNCTION ledger.writer_boundary_active() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE active boolean;
BEGIN
    -- A locking read sees the current epoch, or aborts a stale REPEATABLE READ
    -- transaction. A snapshot-only read would let pre-cutover writers bypass us.
    SELECT writer_boundary INTO STRICT active FROM public.ledger_config WHERE id FOR SHARE;
    RETURN active;
END $$;

CREATE FUNCTION ledger.guard_creator_balance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE expected bigint;
BEGIN
    IF NOT ledger.writer_boundary_active() THEN RETURN NEW; END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.tuzis <> 0 THEN
            RAISE EXCEPTION 'ledger boundary: new creators must start at zero' USING ERRCODE = '23514';
        END IF;
    ELSIF NEW.tuzis IS DISTINCT FROM OLD.tuzis THEN
        SELECT balance INTO expected FROM public.ledger_account WHERE kind='user' AND owner_id=NEW.id;
        IF expected IS NULL OR NEW.tuzis * 1000 <> expected THEN
            RAISE EXCEPTION 'ledger boundary: unjournaled creator balance write' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER ledger_creator_balance_guard BEFORE INSERT OR UPDATE OF tuzis ON public.g12f_creator
FOR EACH ROW EXECUTE FUNCTION ledger.guard_creator_balance();

CREATE FUNCTION ledger.guard_account_available() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF ledger.writer_boundary_active() AND NEW.kind='user' AND NEW.balance < NEW.held THEN
        RAISE EXCEPTION 'ledger boundary: user balance below holds' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER ledger_account_available_guard BEFORE INSERT OR UPDATE ON public.ledger_account
FOR EACH ROW EXECUTE FUNCTION ledger.guard_account_available();

CREATE FUNCTION ledger.guard_boundary_config() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF TG_OP = 'TRUNCATE' THEN
        IF ledger.writer_boundary_active() THEN
            RAISE EXCEPTION 'ledger boundary: configuration cannot be truncated' USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
    END IF;
    IF OLD.writer_boundary THEN
        IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'ledger boundary: configuration cannot be deleted' USING ERRCODE = '23514';
        END IF;
        IF NOT NEW.writer_boundary OR NEW.heal_enabled OR NOT NEW.dual_write THEN
            RAISE EXCEPTION 'ledger boundary: activation cannot be reversed' USING ERRCODE = '23514';
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    IF NEW.writer_boundary AND (NEW.heal_enabled OR NOT NEW.dual_write) THEN
        RAISE EXCEPTION 'ledger boundary: activation requires dual-write without healing' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER ledger_boundary_config_guard BEFORE UPDATE OR DELETE ON public.ledger_config
FOR EACH ROW EXECUTE FUNCTION ledger.guard_boundary_config();
CREATE TRIGGER ledger_boundary_config_truncate_guard BEFORE TRUNCATE ON public.ledger_config
FOR EACH STATEMENT EXECUTE FUNCTION ledger.guard_boundary_config();

CREATE FUNCTION ledger.activate_writer_boundary() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'ledger boundary: activation requires READ COMMITTED';
    END IF;
    -- Block all old writes before locking the config epoch: ordinary writers
    -- acquire creator/account locks before the config SHARE lock.
    LOCK TABLE public.g12f_creator IN ACCESS EXCLUSIVE MODE;
    LOCK TABLE public.ledger_account IN ACCESS EXCLUSIVE MODE;
    PERFORM 1 FROM public.ledger_config WHERE id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ledger boundary: missing configuration'; END IF;
    IF EXISTS (
        SELECT 1 FROM public.g12f_creator c LEFT JOIN public.ledger_account a
          ON a.owner_id=c.id AND a.kind='user'
        WHERE a.id IS NULL OR a.balance <> c.tuzis*1000 OR a.balance < a.held
    ) THEN
        RAISE EXCEPTION 'ledger boundary: backfill, balance reconciliation or held coverage incomplete';
    END IF;
    UPDATE public.ledger_config SET writer_boundary=true, heal_enabled=false WHERE id;
END $$;
REVOKE ALL ON FUNCTION ledger.writer_boundary_active(), ledger.guard_creator_balance(),
ledger.guard_account_available(), ledger.guard_boundary_config(), ledger.activate_writer_boundary() FROM PUBLIC;
"""

REVERSE = r"""
DO $$ BEGIN
    IF ledger.writer_boundary_active() THEN
        RAISE EXCEPTION 'ledger boundary: active protection cannot be rolled back';
    END IF;
END $$;
DROP TRIGGER ledger_creator_balance_guard ON public.g12f_creator;
DROP TRIGGER ledger_account_available_guard ON public.ledger_account;
DROP TRIGGER ledger_boundary_config_guard ON public.ledger_config;
DROP TRIGGER ledger_boundary_config_truncate_guard ON public.ledger_config;
DROP FUNCTION ledger.activate_writer_boundary(), ledger.guard_creator_balance(),
ledger.guard_account_available(), ledger.guard_boundary_config(), ledger.writer_boundary_active();
"""


class Migration(migrations.Migration):
    dependencies = [('ledger', '0001_initial')]
    operations = [
        migrations.RunSQL(LOCKS, migrations.RunSQL.noop),
        migrations.AddField('config', 'writer_boundary', models.BooleanField(db_default=False)),
        migrations.RunSQL(SQL, LOCKS + REVERSE),
    ]
