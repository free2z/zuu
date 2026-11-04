"""Frozen DB guards. Foundation intentionally cannot activate the new policy.

A later independently reviewed integration migration must replace the
activation blocker after every writer and service adapter is implemented.
"""
SQL = r"""
CREATE SCHEMA economy;
REVOKE ALL ON SCHEMA economy FROM PUBLIC;
INSERT INTO economy_economicpolicy(id,version,fenced,account_daily_limit_m2z,purchaser_daily_limit_nusd,manifest)
VALUES(true,0,false,200000000,10000000000000,'{}');

CREATE FUNCTION economy.policy() RETURNS public.economy_economicpolicy
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.economy_economicpolicy;
BEGIN
    SELECT * INTO p FROM public.economy_economicpolicy WHERE id FOR SHARE NOWAIT;
    IF p.fenced THEN RAISE EXCEPTION 'economic_writers_fenced' USING ERRCODE='23514'; END IF;
    IF p.version > 0 AND current_setting('free2z.economic_policy_version',true) IS DISTINCT FROM p.version::text THEN
        RAISE EXCEPTION 'economic_policy_version_mismatch' USING ERRCODE='23514';
    END IF;
    IF p.version>0 AND NOT EXISTS(SELECT 1 FROM public.ledger_config WHERE id AND writer_boundary AND NOT heal_enabled AND dual_write) THEN
        RAISE EXCEPTION 'economic_policy_requires_ledger_writer_boundary' USING ERRCODE='23514';
    END IF;
    RETURN p;
END $$;

CREATE FUNCTION economy.guard_policy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
    IF TG_OP='DELETE' AND OLD.version>0 THEN RAISE EXCEPTION 'active policy cannot be deleted'; END IF;
    IF TG_OP='UPDATE' AND NEW.version IS DISTINCT FROM OLD.version THEN
        RAISE EXCEPTION 'activation unavailable: writer integration and cutover review required' USING ERRCODE='23514';
    END IF;
    IF TG_OP='INSERT' AND NEW.version<>0 THEN RAISE EXCEPTION 'policy must start disabled'; END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER economy_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON economy_economicpolicy
FOR EACH ROW EXECUTE FUNCTION economy.guard_policy();

CREATE FUNCTION economy.guard_usage_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.economy_economicpolicy; day_utc date;
BEGIN
    p:=economy.policy();
    IF coalesce(p.version,0)=0 OR NEW.kind<>'user' THEN RETURN NEW; END IF;
    IF TG_OP='INSERT' THEN
        IF NEW.balance<>0 THEN RAISE EXCEPTION 'new usage account must start at zero'; END IF;
        RETURN NEW;
    END IF;
    day_utc:=(statement_timestamp() AT TIME ZONE 'UTC')::date;
    INSERT INTO public.economy_fundingday(account_id,day,opening_m2z,incoming_m2z,reserved_m2z)
    VALUES(OLD.id,day_utc,greatest(OLD.balance,0),0,0) ON CONFLICT(account_id,day) DO NOTHING;
    RETURN NEW;
END $$;
CREATE TRIGGER economy_usage_account_guard BEFORE INSERT OR UPDATE ON ledger_account
FOR EACH ROW EXECUTE FUNCTION economy.guard_usage_account();

CREATE FUNCTION economy.guard_usage_transfer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.economy_economicpolicy; recipient public.ledger_account;
    d public.economy_fundingday; day_utc date; restored bigint;
BEGIN
    p:=economy.policy();
    IF coalesce(p.version,0)=0 THEN RETURN NEW; END IF;
    SELECT * INTO recipient FROM public.ledger_account WHERE id=NEW.credit_account_id;
    -- Dispute wins restore existing receipt rights, including debt repayment;
    -- they are not a new sale. Cursor plus net original clawback journal bound
    -- every restoration leg and reject forged/duplicate credits.
    IF NEW.code='restore' OR (NEW.code='debt_repay' AND NEW.meta->>'origin'='restore') THEN
        SELECT coalesce(sum(CASE WHEN t.code IN ('clawback','clawback_debt') AND t.debit_account_id IN
            (SELECT id FROM public.ledger_account WHERE owner_id=recipient.owner_id AND kind IN ('user','user_debt')) THEN t.amount
            WHEN (t.code='restore' OR (t.code='debt_repay' AND t.meta->>'origin'='restore')) THEN -t.amount ELSE 0 END),0)
          INTO restored FROM public.ledger_transfer t WHERE t.ref_kind=NEW.ref_kind AND t.ref_id=NEW.ref_id;
        IF restored<NEW.amount OR NOT EXISTS(SELECT 1 FROM public.ledger_purchase_refund r
            JOIN public.ledger_account a ON a.id=r.account_id
            JOIN public.ledger_account clearing ON clearing.key='sys:clearing_'||r.rail
            WHERE r.ref_kind=NEW.ref_kind AND r.ref_id=NEW.ref_id AND a.owner_id=recipient.owner_id
              AND r.refunded_m2z>=NEW.amount AND clearing.id=NEW.debit_account_id) THEN
            RAISE EXCEPTION 'unbacked purchase restoration';
        END IF;
        IF recipient.kind='user_debt' THEN RETURN NEW; END IF;
        -- Restored spendable usage still consumes daily associated-value
        -- allowance. A refusal leaves the original refund cursor untouched;
        -- adapter records a durable resolution claim, never erases rights.
    END IF;
    IF EXISTS(SELECT 1 FROM public.ledger_account WHERE id=NEW.debit_account_id AND key LIKE 'sys:clearing_%')
       AND NEW.code IN ('purchase','debt_repay') AND recipient.kind IN ('user','user_debt') THEN
        IF NOT EXISTS(SELECT 1 FROM public.economy_fundingreservation r
            JOIN public.ledger_account a ON a.id=r.account_id
            WHERE NEW.ref_kind='funding_reservation' AND r.id::text=NEW.ref_id
              AND r.state='issuing' AND a.owner_id=recipient.owner_id
              AND NEW.amount+coalesce((SELECT sum(t.amount) FROM public.ledger_transfer t
                  WHERE t.ref_kind=NEW.ref_kind AND t.ref_id=NEW.ref_id AND t.code IN ('purchase','debt_repay')),0)<=r.amount_m2z) THEN
            RAISE EXCEPTION 'purchase_requires_funding_reservation' USING ERRCODE='23514';
        END IF;
    END IF;
    -- Verified return of a *debited* legacy reservation is restoration, not
    -- fresh funding. Bound cumulative returns by the original journal debit.
    IF (NEW.code='refund' OR (NEW.code='debt_repay' AND NEW.meta->>'origin'='refund')) AND NEW.ref_kind='reservation' AND EXISTS(
        SELECT 1 FROM public.ledger_account WHERE id=NEW.debit_account_id AND key='sys:reservation_clearing'
    ) THEN
        SELECT coalesce(sum(CASE WHEN code='spend' AND debit_account_id IN
            (SELECT id FROM public.ledger_account WHERE kind='user' AND owner_id=recipient.owner_id) THEN amount
            WHEN credit_account_id IN (SELECT id FROM public.ledger_account WHERE owner_id=recipient.owner_id)
                AND (code='refund' OR (code='debt_repay' AND meta->>'origin'='refund')) THEN -amount ELSE 0 END),0)
        INTO restored FROM public.ledger_transfer
        WHERE ref_kind='reservation' AND ref_id=NEW.ref_id;
        IF restored < NEW.amount THEN RAISE EXCEPTION 'unbacked reservation restoration'; END IF;
        RETURN NEW;
    END IF;
    IF recipient.kind<>'user' THEN RETURN NEW; END IF;
    day_utc:=(statement_timestamp() AT TIME ZONE 'UTC')::date;
    SELECT * INTO STRICT d FROM public.economy_fundingday WHERE account_id=recipient.id AND day=day_utc FOR UPDATE;
    -- post_transfer has already increased the account, but its BEFORE UPDATE
    -- guard captured the opening balance before the first change of this day.
    IF d.opening_m2z+d.incoming_m2z+coalesce((SELECT sum(amount_m2z) FROM public.economy_fundingreservation WHERE account_id=recipient.id AND state='reserved'),0)+NEW.amount>p.account_daily_limit_m2z THEN
        RAISE EXCEPTION 'usage_daily_funding_limit' USING ERRCODE='23514';
    END IF;
    UPDATE public.economy_fundingday SET incoming_m2z=incoming_m2z+NEW.amount WHERE id=d.id;
    RETURN NEW;
END $$;
CREATE TRIGGER economy_usage_transfer_guard BEFORE INSERT ON ledger_transfer
FOR EACH ROW EXECUTE FUNCTION economy.guard_usage_transfer();

CREATE FUNCTION economy.immutable_record() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'immutable economic record: append an attributable correction' USING ERRCODE='23514'; END $$;
CREATE TRIGGER economy_legacy_snapshot_immutable BEFORE UPDATE OR DELETE ON economy_legacyclaim
FOR EACH ROW EXECUTE FUNCTION economy.immutable_record();
CREATE TRIGGER economy_legacy_decision_immutable BEFORE UPDATE OR DELETE ON economy_legacyclaimdecision
FOR EACH ROW EXECUTE FUNCTION economy.immutable_record();
CREATE TRIGGER economy_payee_immutable BEFORE UPDATE OR DELETE ON economy_legalpayee
FOR EACH ROW EXECUTE FUNCTION economy.immutable_record();
CREATE TRIGGER economy_journal_immutable BEFORE UPDATE OR DELETE ON economy_payablejournal
FOR EACH ROW EXECUTE FUNCTION economy.immutable_record();
CREATE TRIGGER economy_admission_immutable BEFORE UPDATE OR DELETE ON economy_serviceadmission
FOR EACH ROW EXECUTE FUNCTION economy.immutable_record();
CREATE TRIGGER economy_schedule_immutable BEFORE UPDATE OR DELETE ON economy_compensationschedule
FOR EACH ROW EXECUTE FUNCTION economy.immutable_record();

CREATE FUNCTION economy.guard_agreement() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
    IF TG_OP='DELETE' OR (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at')
       OR OLD.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'agreement evidence immutable; only first revocation permitted';
    END IF;
    IF NEW.revoked_at IS NULL OR NEW.revoked_at<OLD.effective_at THEN RAISE EXCEPTION 'invalid agreement revocation'; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER economy_agreement_guard BEFORE UPDATE OR DELETE ON economy_compensationagreement
FOR EACH ROW EXECUTE FUNCTION economy.guard_agreement();

CREATE FUNCTION economy.project_payable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.economy_economicpolicy; a public.economy_serviceadmission;
    s public.economy_compensationschedule; owner bigint; payee uuid;
BEGIN
    p:=economy.policy();
    IF coalesce(p.version,0)<>1 THEN RAISE EXCEPTION 'creator compensation disabled'; END IF;
    IF NEW.kind='service' THEN
        SELECT * INTO STRICT a FROM public.economy_serviceadmission WHERE id=NEW.admission_id;
        SELECT * INTO STRICT s FROM public.economy_compensationschedule WHERE id=a.schedule_id;
        SELECT creator_id,legal_payee_id INTO STRICT owner,payee FROM public.economy_creatorpayable WHERE id=NEW.account_id;
        IF owner<>a.creator_id OR payee IS DISTINCT FROM a.legal_payee_id OR NEW.account_id<>a.account_id OR a.policy_version<>p.version
           OR NEW.allocated_m2z IS NULL OR NEW.delta_nusd::numeric IS DISTINCT FROM NEW.allocated_m2z::numeric*s.nusd_per_allocated_m2z THEN
            RAISE EXCEPTION 'invalid service compensation';
        END IF;
    ELSIF NEW.kind='adjustment' THEN
        IF NOT (NEW.basis ?& ARRAY['contractual_basis','reason','source_reference','operator']) THEN RAISE EXCEPTION 'unattributable payable adjustment'; END IF;
        IF EXISTS(SELECT 1 FROM public.economy_creatorpayable WHERE id=NEW.account_id AND balance_nusd+NEW.delta_nusd<held_nusd) THEN
            RAISE EXCEPTION 'adjustment cannot consume committed payment holds';
        END IF;
    ELSIF NEW.kind='payment' THEN
        IF NOT EXISTS(SELECT 1 FROM public.economy_paymentrequest WHERE id=NEW.payment_id AND id::text=NEW.basis->>'payment_id' AND account_id=NEW.account_id AND amount_nusd=-NEW.delta_nusd AND state='broadcast' AND txid=NEW.basis->>'txid') THEN
            RAISE EXCEPTION 'payment journal has no matching broadcast obligation';
        END IF;
    ELSIF NEW.kind='usage_purchase' THEN
        RAISE EXCEPTION 'earnings-funded usage integration not installed';
    END IF;
    UPDATE public.economy_creatorpayable SET balance_nusd=balance_nusd+NEW.delta_nusd WHERE id=NEW.account_id;
    RETURN NEW;
END $$;
CREATE TRIGGER economy_journal_projection AFTER INSERT ON economy_payablejournal
FOR EACH ROW EXECUTE FUNCTION economy.project_payable();

CREATE FUNCTION economy.check_payable_projection() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actual bigint; expected numeric; actual_held bigint; expected_held numeric; v_account bigint;
BEGIN
    IF TG_TABLE_NAME='economy_creatorpayable' THEN v_account:=NEW.id; ELSE v_account:=NEW.account_id; END IF;
    SELECT balance_nusd,held_nusd INTO actual,actual_held FROM public.economy_creatorpayable WHERE id=v_account;
    SELECT coalesce(sum(delta_nusd),0) INTO expected FROM public.economy_payablejournal WHERE economy_payablejournal.account_id=v_account;
    IF actual::numeric<>expected THEN RAISE EXCEPTION 'USD payable projection disagrees with immutable journal'; END IF;
    SELECT coalesce(sum(amount_nusd),0) INTO expected_held FROM public.economy_paymentrequest WHERE economy_paymentrequest.account_id=v_account AND state NOT IN ('confirmed','rejected');
    IF actual_held>actual THEN RAISE EXCEPTION 'USD payable holds exceed owed balance'; END IF;
    IF actual_held::numeric<>expected_held THEN RAISE EXCEPTION 'USD payable holds disagree with payment requests'; END IF;
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER economy_payable_projection_check AFTER INSERT OR UPDATE ON economy_creatorpayable
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION economy.check_payable_projection();
CREATE CONSTRAINT TRIGGER economy_payment_hold_check AFTER INSERT OR UPDATE ON economy_paymentrequest
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION economy.check_payable_projection();

CREATE FUNCTION economy.guard_payment() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'payment history cannot be deleted'; END IF;
    IF TG_OP='INSERT' THEN
        IF NEW.state<>'requested' OR NOT EXISTS(SELECT 1 FROM public.economy_creatorpayable
            WHERE id=NEW.account_id AND legal_payee_id=NEW.legal_payee_id AND creator_id=NEW.requested_by_id) THEN
            RAISE EXCEPTION 'payment request identity mismatch';
        END IF;
        RETURN NEW;
    END IF;
    IF (NEW.account_id,NEW.legal_payee_id,NEW.requested_by_id,NEW.amount_nusd,NEW.address,NEW.idempotency_key,NEW.address_authorization,NEW.created_at)
       IS DISTINCT FROM (OLD.account_id,OLD.legal_payee_id,OLD.requested_by_id,OLD.amount_nusd,OLD.address,OLD.idempotency_key,OLD.address_authorization,OLD.created_at)
       OR (OLD.txid IS NOT NULL AND NEW.txid IS DISTINCT FROM OLD.txid) THEN
        RAISE EXCEPTION 'payment routing and obligation identity immutable';
    END IF;
    IF NEW.state<>OLD.state AND NOT (
        (OLD.state='requested' AND NEW.state IN ('approved','rejected')) OR
        (OLD.state='approved' AND NEW.state IN ('signing','rejected')) OR
        (OLD.state='signing' AND NEW.state IN ('broadcast_unknown','broadcast')) OR
        (OLD.state='broadcast_unknown' AND NEW.state='broadcast') OR
        (OLD.state='broadcast' AND NEW.state='confirmed')) THEN
        RAISE EXCEPTION 'payment transition would risk duplicate settlement';
    END IF;
    IF OLD.state IN ('approved','signing','broadcast_unknown','broadcast','confirmed','rejected')
        AND (NEW.review-'rejection'-'rescreening_observations') IS DISTINCT FROM (OLD.review-'rejection'-'rescreening_observations') THEN
        RAISE EXCEPTION 'signed payment review immutable';
    END IF;
    IF NEW.review->'rejection' IS DISTINCT FROM OLD.review->'rejection' AND NOT (
        OLD.state IN ('requested','approved') AND NEW.state='rejected' AND NOT OLD.review ? 'rejection'
        AND coalesce(NEW.review->'rejection'->>'operator','')<>''
        AND coalesce(NEW.review->'rejection'->>'reason','')<>'') THEN
        RAISE EXCEPTION 'payment rejection evidence immutable';
    END IF;
    IF coalesce(NEW.review->'rescreening_observations','[]'::jsonb) IS DISTINCT FROM coalesce(OLD.review->'rescreening_observations','[]'::jsonb) THEN
        IF OLD.state<>'approved' OR NEW.state<>'approved'
            OR jsonb_typeof(NEW.review->'rescreening_observations')<>'array'
            OR jsonb_array_length(NEW.review->'rescreening_observations')<>jsonb_array_length(coalesce(OLD.review->'rescreening_observations','[]'::jsonb))+1
            OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(OLD.review->'rescreening_observations','[]'::jsonb)) WITH ORDINALITY prior_review(value,position)
                WHERE NEW.review->'rescreening_observations'->(prior_review.position::integer-1) IS DISTINCT FROM prior_review.value) THEN
            RAISE EXCEPTION 'payment screening history append-only before signing';
        END IF;
    END IF;
    IF OLD.state IN ('signing','broadcast_unknown','broadcast','confirmed','rejected') THEN
        IF (NEW.settlement-'broadcast_observations') IS DISTINCT FROM (OLD.settlement-'broadcast_observations')
           OR jsonb_typeof(coalesce(NEW.settlement->'broadcast_observations','[]'::jsonb))<>'array'
           OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(OLD.settlement->'broadcast_observations','[]'::jsonb)) WITH ORDINALITY prior_observation(value,position)
              WHERE coalesce(NEW.settlement->'broadcast_observations','[]'::jsonb)->(prior_observation.position::integer-1) IS DISTINCT FROM prior_observation.value) THEN
            RAISE EXCEPTION 'signed payment evidence immutable; append broadcast observations';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER economy_payment_guard BEFORE INSERT OR UPDATE OR DELETE ON economy_paymentrequest
FOR EACH ROW EXECUTE FUNCTION economy.guard_payment();

CREATE FUNCTION economy.guard_payable_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
    IF TG_OP='UPDATE' AND (NEW.creator_id<>OLD.creator_id OR NEW.currency<>OLD.currency
        OR (OLD.legal_payee_id IS NOT NULL AND NEW.legal_payee_id IS DISTINCT FROM OLD.legal_payee_id)) THEN
        RAISE EXCEPTION 'payable identity immutable: explicit debt assignment review required';
    END IF;
    IF NEW.legal_payee_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.economy_legalpayee WHERE id=NEW.legal_payee_id AND verification->>'creator_id'=NEW.creator_id::text) THEN
        RAISE EXCEPTION 'legal payee not verified for this creator';
    END IF;
    IF TG_OP='INSERT' AND (NEW.balance_nusd<>0 OR NEW.held_nusd<>0) THEN
        RAISE EXCEPTION 'new payable must start at zero';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER economy_payable_identity BEFORE INSERT OR UPDATE ON economy_creatorpayable
FOR EACH ROW EXECUTE FUNCTION economy.guard_payable_identity();

CREATE FUNCTION economy.guard_admission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.economy_economicpolicy; a public.economy_compensationagreement;
    s public.economy_compensationschedule; c public.economy_creatorpayable;
BEGIN
    p:=economy.policy();
    IF coalesce(p.version,0)<>1 OR NEW.policy_version<>p.version THEN RAISE EXCEPTION 'compensation admission disabled'; END IF;
    SELECT * INTO STRICT a FROM public.economy_compensationagreement WHERE id=NEW.agreement_id FOR SHARE;
    SELECT * INTO STRICT s FROM public.economy_compensationschedule WHERE id=NEW.schedule_id;
    SELECT * INTO STRICT c FROM public.economy_creatorpayable WHERE id=NEW.account_id;
    IF NOT EXISTS(SELECT 1 FROM public.g12f_creator WHERE id=NEW.creator_id AND is_active) THEN
        RAISE EXCEPTION 'inactive creator cannot admit new compensated work';
    END IF;
    IF a.creator_id<>NEW.creator_id OR c.creator_id<>NEW.creator_id OR a.accepted_by_id<>NEW.creator_id
        OR a.legal_payee_id<>NEW.legal_payee_id OR c.legal_payee_id IS DISTINCT FROM NEW.legal_payee_id
        OR s.service<>NEW.service OR s.contract_version<>a.contract_version
        OR a.effective_at>NEW.admitted_at OR s.effective_at>NEW.admitted_at
        OR (a.revoked_at IS NOT NULL AND a.revoked_at<=NEW.admitted_at)
        OR (s.ends_at IS NOT NULL AND s.ends_at<=NEW.admitted_at)
        OR NEW.admitted_at>statement_timestamp() OR NEW.admitted_at<p.activated_at THEN
        RAISE EXCEPTION 'compensation admission agreement/schedule/payee mismatch';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER economy_admission_guard BEFORE INSERT ON economy_serviceadmission
FOR EACH ROW EXECUTE FUNCTION economy.guard_admission();
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA economy FROM PUBLIC;
"""

REVERSE = r"""
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM economy_economicpolicy WHERE version>0)
       OR EXISTS(SELECT 1 FROM economy_payablejournal)
       OR EXISTS(SELECT 1 FROM economy_serviceadmission)
       OR EXISTS(SELECT 1 FROM economy_fundingreservation)
       OR EXISTS(SELECT 1 FROM economy_legacyclaim)
       OR EXISTS(SELECT 1 FROM economy_legacyclaimdecision)
       OR EXISTS(SELECT 1 FROM economy_compensationagreement)
       OR EXISTS(SELECT 1 FROM economy_legalpayee)
       OR EXISTS(SELECT 1 FROM economy_paymentrequest) THEN
        RAISE EXCEPTION 'economic history exists: forward recovery required';
    END IF;
END $$;
DROP TRIGGER economy_usage_transfer_guard ON ledger_transfer;
DROP TRIGGER economy_usage_account_guard ON ledger_account;
DROP TRIGGER economy_payable_projection_check ON economy_creatorpayable;
DROP TRIGGER economy_journal_projection ON economy_payablejournal;
DROP TRIGGER economy_agreement_guard ON economy_compensationagreement;
DROP TRIGGER economy_schedule_immutable ON economy_compensationschedule;
DROP TRIGGER economy_admission_immutable ON economy_serviceadmission;
DROP TRIGGER economy_journal_immutable ON economy_payablejournal;
DROP TRIGGER economy_payee_immutable ON economy_legalpayee;
DROP TRIGGER economy_legacy_snapshot_immutable ON economy_legacyclaim;
DROP TRIGGER economy_legacy_decision_immutable ON economy_legacyclaimdecision;
DROP TRIGGER economy_payable_identity ON economy_creatorpayable;
DROP TRIGGER economy_payment_guard ON economy_paymentrequest;
DROP TRIGGER economy_payment_hold_check ON economy_paymentrequest;
DROP TRIGGER economy_admission_guard ON economy_serviceadmission;
DROP TRIGGER economy_policy_guard ON economy_economicpolicy;
DROP SCHEMA economy CASCADE;
"""
