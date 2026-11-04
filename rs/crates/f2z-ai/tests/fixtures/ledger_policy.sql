-- Synthetic public ABI fixture only. No private Free2Z schema or money model.
-- The test requires an explicitly named disposable loopback database.
CREATE SCHEMA ledger;
CREATE TABLE ledger.fixture_policy (id integer PRIMARY KEY, version integer, fenced boolean NOT NULL);
INSERT INTO ledger.fixture_policy VALUES (1,0,false);
CREATE TABLE ledger.fixture_operation_lock (id integer PRIMARY KEY);
INSERT INTO ledger.fixture_operation_lock VALUES (1);
CREATE TABLE ledger.fixture_audit (id bigserial PRIMARY KEY, phase text NOT NULL, xid bigint NOT NULL);
CREATE FUNCTION ledger.prepare_economic_policy(integer,integer) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE p ledger.fixture_policy;
BEGIN
    IF $1 <> 0 OR $2 <> 1 THEN RAISE EXCEPTION 'unexpected supported range'; END IF;
    SELECT * INTO STRICT p FROM ledger.fixture_policy WHERE id=1 FOR SHARE NOWAIT;
    IF p.fenced THEN RAISE EXCEPTION 'fixture policy fenced'; END IF;
    PERFORM set_config('fixture.policy_xid', txid_current()::text, true);
    INSERT INTO ledger.fixture_audit(phase,xid) VALUES ('prepare',txid_current());
    RETURN p.version;
END $$;
CREATE FUNCTION ledger.fixture_record(text) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('fixture.policy_xid',true) IS DISTINCT FROM txid_current()::text
    THEN RAISE EXCEPTION 'policy not prepared in this transaction'; END IF;
    IF current_setting('lock_timeout') <> '2s' OR current_setting('statement_timeout') <> '5s'
    THEN RAISE EXCEPTION 'missing local deadlines'; END IF;
    PERFORM id FROM ledger.fixture_operation_lock WHERE id=1 FOR UPDATE;
    INSERT INTO ledger.fixture_audit(phase,xid) VALUES ($1,txid_current());
    RETURN jsonb_build_object('operation',$1);
END $$;
