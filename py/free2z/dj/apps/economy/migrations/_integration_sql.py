"""Frozen additive integration for economy0002; policy remains disabled."""
import re

from ._foundation_sql import SQL as FOUNDATION
from dj.apps.ledger.migrations._l2_lifecycle import SQL as LIFECYCLE


def definition(sql, name):
    match = re.search(r'CREATE (?:OR REPLACE )?FUNCTION ' + re.escape(name) + r'\(.*?END \$\$;', sql, re.S)
    if match is None:
        raise RuntimeError(f'missing frozen PL/pgSQL definition {name}')
    return match[0].replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION', 1)


SQL = r"""
CREATE FUNCTION ledger.prepare_economic_policy(p_min integer,p_max integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.economy_economicpolicy;
BEGIN
 PERFORM ledger.assert_gateway_database();
 IF p_min IS NULL OR p_max IS NULL OR p_min<0 OR p_max>1 OR p_min>p_max THEN
  RAISE EXCEPTION 'unsupported economic policy range' USING ERRCODE='22023'; END IF;
 SELECT * INTO STRICT p FROM public.economy_economicpolicy WHERE id FOR SHARE NOWAIT;
 IF p.version NOT BETWEEN p_min AND p_max THEN RAISE EXCEPTION 'unsupported economic policy' USING ERRCODE='23514'; END IF;
 PERFORM set_config('free2z.economic_policy_version',p.version::text,true);
 PERFORM economy.policy();
 RETURN p.version;
END $$;

CREATE FUNCTION ledger.assert_economic_prepared() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.economy_economicpolicy;
BEGIN
 PERFORM ledger.assert_gateway_database();
 SELECT * INTO STRICT p FROM public.economy_economicpolicy WHERE id FOR SHARE NOWAIT;
 IF p.version NOT IN (0,1) THEN RAISE EXCEPTION 'unsupported economic policy' USING ERRCODE='23514'; END IF;
 -- The lock itself is acquired even when a caller forges the LOCAL tag.
 -- Old policy0 callers remain compatible; stale policy1 metadata fails.
 PERFORM economy.policy();
 RETURN p.version;
END $$;

CREATE FUNCTION economy.memo_json_strings_storable(p_value json) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE item record;scalar text;pending json[]:=ARRAY[p_value];value json;
BEGIN
 WHILE cardinality(pending)>0 LOOP
 value:=pending[cardinality(pending)];pending:=pending[1:cardinality(pending)-1];
 CASE json_typeof(value)
  WHEN 'object' THEN
   FOR item IN SELECT * FROM json_each(value) LOOP
    pending:=array_append(pending,item.value);
   END LOOP;
  WHEN 'array' THEN
   FOR item IN SELECT * FROM json_array_elements(value) LOOP
    pending:=array_append(pending,item.value);
   END LOOP;
  WHEN 'string' THEN scalar:=value#>>'{}';
  ELSE NULL; -- Numeric tokens stay lexical; no NUMERIC cast or range loss.
 END CASE;
 END LOOP;
 RETURN true;
EXCEPTION WHEN untranslatable_character OR invalid_text_representation THEN RETURN false;
END $$;

CREATE FUNCTION economy.raw_note_memo(p_hex text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE b bytea;size integer;t text;j json;
BEGIN
 IF p_hex IS NULL THEN RETURN NULL; END IF;
 IF length(p_hex)<>1024 OR p_hex !~ '^[0-9a-f]+$' THEN RAISE EXCEPTION 'invalid memo hex'; END IF;
 b:=decode(p_hex,'hex');size:=length(b);
 IF get_byte(b,0)>=245 THEN RETURN NULL; END IF;
 WHILE size>0 AND get_byte(b,size-1)=0 LOOP size:=size-1; END LOOP;
 b:=substring(b FROM 1 FOR size);
 IF position(decode('00','hex') IN b)>0 THEN RETURN NULL; END IF;
 BEGIN
  t:=convert_from(b,'UTF8');
 EXCEPTION WHEN character_not_in_repertoire OR untranslatable_character THEN RETURN NULL;
 END;
 -- JSON syntax errors are ordinary text. A syntactically valid JSON value
 -- whose escapes cannot live in PostgreSQL is retained only as raw bytes.
 BEGIN j:=t::json;
 EXCEPTION WHEN invalid_text_representation OR program_limit_exceeded THEN RETURN t; END;
 IF NOT economy.memo_json_strings_storable(j) THEN RETURN NULL; END IF;
 RETURN t;
END $$;

CREATE FUNCTION economy.guard_captured_note() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE prior public.tuzis_idempotencykey;original jsonb;observed timestamptz;
BEGIN
 IF NEW.txid !~ '^[0-9a-f]{64}$' OR (NEW.memo_hex IS NOT NULL AND (length(NEW.memo_hex)<>1024 OR NEW.memo_hex !~ '^[0-9a-f]+$'))
   OR (NEW.memo_hex IS NULL AND (NEW.source->'memo_available' IS DISTINCT FROM 'false'::jsonb OR NEW.memo_plain IS NOT NULL))
   OR NOT (NEW.source ?& ARRAY['source_kind','source_reference']) THEN
  RAISE EXCEPTION 'invalid raw captured note'; END IF;
 -- Only ingestion into THIS backend creates observation time. Caller/chain
 -- timestamps remain evidence fields, never the eligibility clock.
 IF NEW.memo_plain IS DISTINCT FROM economy.raw_note_memo(NEW.memo_hex) THEN
  RAISE EXCEPTION 'raw memo plaintext does not match actual bytes'; END IF;
 NEW.first_seen_at:=statement_timestamp();
 IF NEW.source->>'backend_observation_id' ~ '^[0-9]{1,18}$' THEN
  SELECT * INTO prior FROM public.tuzis_idempotencykey
   WHERE id=(NEW.source->>'backend_observation_id')::bigint AND scope='zec-funding-note'
    AND key=NEW.txid||':'||NEW.pool||':'||NEW.output_index::text;
  original:=prior.response_body->'note';
  IF original->>'txid'=NEW.txid AND original->>'pool'=NEW.pool
   AND original->>'output_index'=NEW.output_index::text
   AND original->>'recipient_id'=prior.user_id::text
   AND original->>'memo_plain' IS NOT DISTINCT FROM NEW.memo_plain
   AND prior.request_hash ~ '^[0-9a-f]{64}$'
   AND (CASE WHEN original->>'amount_zec' ~ '^[0-9]{1,20}(\.[0-9]{1,8})?([eE][+-]?[0-9]{1,2})?$'
      THEN (original->>'amount_zec')::numeric*100000000=NEW.amount_zatoshi ELSE false END) THEN
   BEGIN
    observed:=(prior.response_body->>'first_seen_at')::timestamptz;
    -- Only an already persisted backend record supplies a historical clock.
    -- Its value is not supplied by the daemon or the new capture caller.
    IF observed<=statement_timestamp() AND observed IS NOT NULL THEN NEW.first_seen_at:=observed; END IF;
   EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN NULL;
   END;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER economy_captured_note_guard BEFORE INSERT ON economy_capturedzecnote
FOR EACH ROW EXECUTE FUNCTION economy.guard_captured_note();

CREATE FUNCTION economy.effective_note_memo(p_note uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN n.memo_hex IS NOT NULL THEN n.memo_plain ELSE (SELECT economy.raw_note_memo(d.evidence->>'memo_hex')
   FROM public.economy_zecnotedisposition d WHERE d.note_id=n.id AND d.event_key='memo-hydration:'||n.id::text) END
 FROM public.economy_capturedzecnote n WHERE n.id=p_note
$$;

CREATE FUNCTION economy.guard_note_observation_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE n public.economy_capturedzecnote;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.scope='zec-funding-note' THEN
   NEW.response_body:=jsonb_set(NEW.response_body,'{first_seen_at}',to_jsonb(statement_timestamp()));
   IF coalesce(NEW.response_body->>'captured_note_id','') ~ '^[0-9a-f-]{36}$' THEN
    SELECT * INTO n FROM public.economy_capturedzecnote WHERE id=(NEW.response_body->>'captured_note_id')::uuid;
    IF n.txid=NEW.response_body->'note'->>'txid' AND n.pool=NEW.response_body->'note'->>'pool'
     AND n.output_index::text=NEW.response_body->'note'->>'output_index'
     AND economy.effective_note_memo(n.id) IS NOT DISTINCT FROM NEW.response_body->'note'->>'memo_plain'
     AND (CASE WHEN NEW.response_body->'note'->>'amount_zec' ~ '^[0-9]{1,20}(\.[0-9]{1,8})?([eE][+-]?[0-9]{1,2})?$'
      THEN (NEW.response_body->'note'->>'amount_zec')::numeric*100000000=n.amount_zatoshi ELSE false END) THEN
       NEW.response_body:=jsonb_set(NEW.response_body,'{first_seen_at}',to_jsonb(n.first_seen_at));
    ELSE RAISE EXCEPTION 'compatibility observation lacks exact original captured note'; END IF;
   END IF;
  END IF;
  RETURN NEW;
 END IF;
 IF OLD.scope='zec-funding-note' AND (
  (NEW.scope,NEW.key,NEW.user_id,NEW.request_hash) IS DISTINCT FROM (OLD.scope,OLD.key,OLD.user_id,OLD.request_hash)
  OR NEW.response_body->'note' IS DISTINCT FROM OLD.response_body->'note'
  OR NEW.response_body->'first_seen_at' IS DISTINCT FROM OLD.response_body->'first_seen_at') THEN
   RAISE EXCEPTION 'original backend note observation immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER economy_note_observation_identity BEFORE INSERT OR UPDATE ON tuzis_idempotencykey
FOR EACH ROW EXECUTE FUNCTION economy.guard_note_observation_identity();

CREATE FUNCTION economy.guard_supplier_offer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a public.economy_compensationagreement;s public.economy_compensationschedule;
 c public.economy_creatorpayable;app public.ledger_app;
BEGIN
 SELECT * INTO STRICT app FROM public.ledger_app WHERE id=NEW.app_id FOR SHARE;
 SELECT * INTO STRICT c FROM public.economy_creatorpayable WHERE id=NEW.account_id;
 SELECT * INTO STRICT a FROM public.economy_compensationagreement WHERE id=NEW.agreement_id FOR SHARE;
 SELECT * INTO STRICT s FROM public.economy_compensationschedule WHERE id=NEW.schedule_id;
 IF app.developer_creator_id IS DISTINCT FROM NEW.creator_id OR app.frozen
  OR c.creator_id<>NEW.creator_id OR c.legal_payee_id IS DISTINCT FROM NEW.legal_payee_id
  OR a.creator_id<>NEW.creator_id OR a.legal_payee_id<>NEW.legal_payee_id OR a.revoked_at IS NOT NULL
  OR a.effective_at>statement_timestamp() OR s.effective_at>statement_timestamp()
  OR (s.ends_at IS NOT NULL AND s.ends_at<=statement_timestamp())
  OR s.service<>'sdk_application' OR s.version<>'sdk-application-2026-10-v2'
  OR s.published_digest<>'acd073acf91613df8eef5e5c4548766c744e9d7fe344c05f4d7b62a56802b59f'
  OR a.contract_version<>'cc-2026-10-v2' OR s.contract_version<>a.contract_version
  OR a.contract_digest<>'aa237c3a7f18c5569aea6ce5d48aed2af4ff6efffec65a185b766c079daedad0'
  OR NOT coalesce(a.acceptance_evidence->'schedules' @> jsonb_build_array(jsonb_build_object(
    'service',s.service,'version',s.version,'digest',s.published_digest)),false)
  OR NEW.markup_bps NOT BETWEEN 1 AND 10000
  OR NOT EXISTS(SELECT 1 FROM public.g12f_creator WHERE id=NEW.approved_by_id AND is_active AND is_staff)
  OR NOT EXISTS(SELECT 1 FROM public.g12f_creator WHERE id=NEW.creator_id AND is_active)
  OR NOT (NEW.evidence ?& ARRAY['contribution_reference','license_reference','delivery_scope_reference',
      'refund_responsibility_reference','approval_reference']) THEN
  RAISE EXCEPTION 'supplier offer lacks approved original license/identity/terms'; END IF;
 NEW.approved_at:=statement_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER economy_supplier_offer_guard BEFORE INSERT ON economy_supplierofferapproval
FOR EACH ROW EXECUTE FUNCTION economy.guard_supplier_offer();

CREATE FUNCTION economy.guard_offer_revocation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.g12f_creator WHERE id=NEW.operator_id AND is_active AND is_staff)
 OR NOT (NEW.evidence ?& ARRAY['reason','source_reference']) THEN RAISE EXCEPTION 'unattributable offer revocation'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER economy_offer_revocation_guard BEFORE INSERT ON economy_supplierofferrevocation
FOR EACH ROW EXECUTE FUNCTION economy.guard_offer_revocation();

CREATE FUNCTION economy.lock_sdk_parties(p_subject uuid,p_app uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE buyer bigint;supplier bigint;who bigint;
BEGIN
 SELECT id INTO buyer FROM public.g12f_creator WHERE public_id=p_subject;
 SELECT developer_creator_id INTO supplier FROM public.ledger_app WHERE id=p_app FOR SHARE;
 FOR who IN SELECT id FROM public.g12f_creator WHERE id IN (buyer,supplier) ORDER BY id LOOP
  PERFORM ledger.lock_creator(who);
 END LOOP;
END $$;

CREATE FUNCTION economy.admit_sdk_call(p_subject uuid,p_app uuid,p_call uuid,p_aep integer,p_agen integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE i record;app public.ledger_app;o public.economy_supplierofferapproval;
 buyer bigint;a uuid;buyer_person text;supplier_person text;original_source jsonb;
BEGIN
 SELECT * INTO i FROM ledger.gateway_identity(p_subject,p_app,p_aep,p_agen);
 IF i.account_id IS NULL OR i.effective_markup_bps=0 THEN RETURN; END IF;
 SELECT * INTO STRICT app FROM public.ledger_app WHERE id=p_app;
 SELECT owner_id INTO buyer FROM public.ledger_account WHERE id=i.account_id;
 SELECT * INTO o FROM public.economy_supplierofferapproval x WHERE app_id=p_app
  AND creator_id=app.developer_creator_id AND markup_bps>=i.effective_markup_bps
  AND NOT EXISTS(SELECT 1 FROM public.economy_supplierofferrevocation WHERE offer_id=x.id)
  ORDER BY approved_at DESC,id LIMIT 1;
 IF o.id IS NULL THEN RAISE EXCEPTION 'sdk_supplier_onboarding_required' USING ERRCODE='23514'; END IF;
 SELECT p.verification->>'legal_person_reference' INTO buyer_person FROM public.economy_creatorpayable c
  JOIN public.economy_legalpayee p ON p.id=c.legal_payee_id WHERE c.creator_id=buyer;
 SELECT verification->>'legal_person_reference' INTO supplier_person FROM public.economy_legalpayee WHERE id=o.legal_payee_id;
 IF buyer=o.creator_id OR (buyer_person IS NOT NULL AND buyer_person<>'' AND buyer_person=supplier_person) THEN
  RAISE EXCEPTION 'compensated_self_service_unsupported' USING ERRCODE='23514'; END IF;
 a:=ledger.uuid_v7();
 original_source:=jsonb_build_object('source_kind','licensed_sdk_application',
  'source_id',p_app,'offer_id',o.id,'offer_evidence_digest',o.evidence_digest,
  'subject_creator_id',buyer,'call_id',p_call,'effective_markup_bps',i.effective_markup_bps,
  'authorization_reference',p_call,'delivery_scope_reference',o.evidence->>'delivery_scope_reference');
 INSERT INTO public.economy_serviceadmission(id,service,event_id,creator_id,agreement_id,schedule_id,
  legal_payee_id,policy_version,admitted_at,account_id,source,source_digest)
 VALUES(a,'sdk_application',p_call::text,o.creator_id,o.agreement_id,o.schedule_id,o.legal_payee_id,1,
  statement_timestamp(),o.account_id,original_source,
  encode(sha256(convert_to(original_source::text,'UTF8')),'hex'));
 INSERT INTO public.economy_sdkserviceadmission(call_id,admission_id,offer_id,subject_id) VALUES(p_call,a,o.id,buyer);
END $$;

CREATE FUNCTION economy.guard_sdk_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.economy_serviceadmission a
  JOIN public.economy_supplierofferapproval o ON o.id=NEW.offer_id
  JOIN public.ledger_gateway_call c ON c.id=NEW.call_id
  JOIN public.ledger_account u ON u.id=c.account_id WHERE a.id=NEW.admission_id
  AND a.service='sdk_application' AND a.event_id=c.id::text AND a.source->>'call_id'=c.id::text
  AND a.creator_id=o.creator_id AND a.account_id=o.account_id AND a.legal_payee_id=o.legal_payee_id
  AND a.agreement_id=o.agreement_id AND a.schedule_id=o.schedule_id
  AND a.source->>'offer_id'=o.id::text AND c.app_id=o.app_id AND u.owner_id=NEW.subject_id
  AND a.source->>'subject_creator_id'=NEW.subject_id::text) THEN RAISE EXCEPTION 'invalid original SDK binding'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER economy_sdk_binding_guard BEFORE INSERT ON economy_sdkserviceadmission
FOR EACH ROW EXECUTE FUNCTION economy.guard_sdk_binding();

CREATE FUNCTION economy.lock_sdk_hold_parties(p_hold uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE who bigint;
BEGIN
 FOR who IN SELECT id FROM public.g12f_creator WHERE id IN (
  SELECT x.subject_id FROM public.economy_sdkserviceadmission x JOIN public.ledger_hold h ON h.logical_key=x.call_id::text WHERE h.id=p_hold
  UNION SELECT a.creator_id FROM public.economy_serviceadmission a JOIN public.economy_sdkserviceadmission x ON x.admission_id=a.id
   JOIN public.ledger_hold h ON h.logical_key=x.call_id::text WHERE h.id=p_hold
  UNION SELECT x.subject_id FROM public.economy_sdkserviceadmission x JOIN public.ledger_ai_usage u ON u.logical_key=x.call_id::text WHERE u.hold_id=p_hold
  UNION SELECT a.creator_id FROM public.economy_serviceadmission a JOIN public.economy_sdkserviceadmission x ON x.admission_id=a.id
   JOIN public.ledger_ai_usage u ON u.logical_key=x.call_id::text WHERE u.hold_id=p_hold
  ) ORDER BY id LOOP PERFORM ledger.lock_creator(who); END LOOP;
END $$;
"""

# Add exact current publication/consent restrictions to the original FK/time
# guard. The original historical schedule rows and journals stay intact.
admission = definition(FOUNDATION, 'economy.guard_admission')
admission = admission.replace('    RETURN NEW;', r"""
    IF NEW.service NOT IN ('livestream_ppv','sdk_application')
      OR a.contract_version<>'cc-2026-10-v2'
      OR a.contract_digest<>'aa237c3a7f18c5569aea6ce5d48aed2af4ff6efffec65a185b766c079daedad0'
      OR s.nusd_per_allocated_m2z<>10000
      OR (NEW.service='sdk_application' AND (s.version<>'sdk-application-2026-10-v2'
          OR s.published_digest<>'acd073acf91613df8eef5e5c4548766c744e9d7fe344c05f4d7b62a56802b59f'))
      OR (NEW.service='livestream_ppv' AND (s.version<>'livestream-ppv-2026-10-v2'
          OR s.published_digest<>'643f853012f4756c2c2ba118845fcf55f82e0c97e328ac3d0d65afd217b1f550'))
      OR NOT coalesce(a.acceptance_evidence->'schedules' @> jsonb_build_array(jsonb_build_object(
        'service',s.service,'version',s.version,'digest',s.published_digest)),false)
      OR NOT EXISTS(SELECT 1 FROM public.g12f_creator WHERE id::text=NEW.source->>'subject_creator_id'
        AND id<>NEW.creator_id AND is_active)
      OR NOT (NEW.source ?& ARRAY['source_kind','source_id','authorization_reference','delivery_scope_reference']) THEN
        RAISE EXCEPTION 'compensation admission lacks current actual service/consent/source';
    END IF;
    IF NEW.service='livestream_ppv' AND NOT EXISTS(SELECT 1 FROM public.dyte_creatormeeting m
      WHERE m.id::text=NEW.source->>'creator_meeting_id' AND m.creator_id=NEW.creator_id
       AND m.meeting_id=NEW.source->>'meeting_id' AND m.meeting_id=NEW.source->>'source_id'
       AND m.provider_session_id::text=NEW.source->>'provider_session_id'
       AND m.host_session_id::text=NEW.source->>'host_session_id'
       AND m.price_per_minute::text=NEW.source->>'price_per_minute_2z'
       AND m.meeting_type='ppv' AND m.is_public AND m.live_now AND m.lifecycle_state='live') THEN
      RAISE EXCEPTION 'PPV admission lacks actual original live offer';
    END IF;
    RETURN NEW;""")
SQL += admission

# A review observation is about the immutable recipient/address, never another
# request. Preserve the original append-only screening and signing rules.
payment_guard = definition(FOUNDATION, 'economy.guard_payment')
payment_guard = payment_guard.replace('    RETURN NEW;\nEND $$;', r"""
    IF NEW.state IN ('approved','signing','broadcast_unknown','broadcast','confirmed') AND (
       NEW.review->>'legal_payee_id' IS DISTINCT FROM NEW.legal_payee_id::text
       OR NEW.review->>'address' IS DISTINCT FROM NEW.address
       OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(NEW.review->'rescreening_observations','[]'::jsonb)) item
          WHERE item->>'legal_payee_id' IS DISTINCT FROM NEW.legal_payee_id::text
             OR item->>'address' IS DISTINCT FROM NEW.address
             OR item ? 'rescreening_observations' OR item ? 'rejection')) THEN
       RAISE EXCEPTION 'payment screening identity mismatch';
    END IF;
    RETURN NEW;
END $$;""")
SQL += payment_guard
SQL += r"""
CREATE FUNCTION economy.check_payment_discharge() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.economy_paymentrequest; payment uuid; journal_count bigint; exact_count bigint;
BEGIN
 IF TG_TABLE_NAME='economy_paymentrequest' THEN payment:=NEW.id;
 ELSE payment:=NEW.payment_id; END IF;
 IF payment IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO STRICT p FROM public.economy_paymentrequest WHERE id=payment;
 SELECT count(*),count(*) FILTER(WHERE kind='payment' AND account_id=p.account_id
   AND delta_nusd=-p.amount_nusd AND basis->>'payment_id'=p.id::text
   AND basis->>'txid'=p.txid) INTO journal_count,exact_count
   FROM public.economy_payablejournal WHERE payment_id=p.id;
 IF (p.state='confirmed' AND (journal_count<>1 OR exact_count<>1 OR p.txid IS NULL))
   OR (p.state<>'confirmed' AND journal_count<>0) THEN
   RAISE EXCEPTION 'confirmed payment and exact debt discharge must commit together';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER economy_payment_discharge_check AFTER INSERT OR UPDATE ON economy_paymentrequest
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION economy.check_payment_discharge();
CREATE CONSTRAINT TRIGGER economy_journal_discharge_check AFTER INSERT ON economy_payablejournal
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION economy.check_payment_discharge();
"""

SQL += r"""
CREATE FUNCTION economy.guard_delivery() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a public.economy_serviceadmission;u public.ledger_ai_usage;viewer bigint;
BEGIN
 PERFORM economy.policy();
 SELECT * INTO STRICT a FROM public.economy_serviceadmission WHERE id=NEW.admission_id;
 IF NEW.service<>a.service OR NEW.evidence->>'admission_id' IS DISTINCT FROM a.id::text
  OR NEW.evidence->>'delivery_reference' IS NULL OR NEW.evidence->>'allocation_reference' IS NULL THEN
  RAISE EXCEPTION 'delivery does not match captured admission'; END IF;
 IF NEW.service='livestream_ppv' THEN
  IF NOT EXISTS(SELECT 1 FROM public.dyte_webhookdelivery w
    WHERE w.provider_event_id::text=NEW.evidence->>'provider_event_id'
      AND w.business_event_key=NEW.provider_key AND w.event_type='meeting.participantLeft'
      AND w.payload_sha256=NEW.evidence->>'payload_sha256') THEN
    RAISE EXCEPTION 'PPV delivery lacks original verified provider evidence'; END IF;
  IF NEW.cohort IS DISTINCT FROM ((a.source->>'provider_session_id')||':'||(a.source->>'subject_creator_id'))
   OR NEW.evidence->>'provider_session_id' IS DISTINCT FROM a.source->>'provider_session_id'
   OR NEW.evidence->>'participant_id' IS DISTINCT FROM 'ea_'||replace(a.id::text,'-','')
   OR NEW.interval IS NULL OR isempty(NEW.interval) OR lower_inf(NEW.interval) OR upper_inf(NEW.interval)
   OR NOT lower_inc(NEW.interval) OR upper_inc(NEW.interval)
   OR lower(NEW.interval)<a.admitted_at OR upper(NEW.interval)>statement_timestamp()
   OR NOT EXISTS(SELECT 1 FROM public.ledger_transfer t WHERE t.id::text=NEW.evidence->>'creator_transfer_id'
      AND t.ref_kind='ppv_service' AND t.ref_id=NEW.provider_key AND t.amount=NEW.allocated_m2z
      AND t.code='spend_up_to' AND t.credit_account_id IN (SELECT id FROM public.ledger_account WHERE key='sys:platform_revenue')
      AND t.debit_account_id IN (SELECT id FROM public.ledger_account WHERE kind='user'
        AND owner_id::text=a.source->>'subject_creator_id')) AND NEW.allocated_m2z>0 THEN
    RAISE EXCEPTION 'PPV delivery lacks exact original interval/collection'; END IF;
 ELSIF NEW.service='sdk_application' THEN
  SELECT * INTO u FROM public.ledger_ai_usage WHERE id::text=NEW.evidence->>'usage_id'
   AND created_at=(NEW.evidence->>'usage_created_at')::timestamptz;
  IF u.id IS NULL OR u.logical_key<>a.event_id OR NEW.interval IS NOT NULL
    OR NEW.allocated_m2z<>u.developer_m2z OR NEW.provider_key<>'sdk:'||u.hold_id::text
    OR NOT EXISTS(SELECT 1 FROM public.economy_sdkserviceadmission x
      JOIN public.ledger_gateway_call c ON c.id=x.call_id WHERE x.admission_id=a.id
      AND c.account_id=u.account_id AND c.app_id=u.app_id AND c.completion_meta IS NOT NULL
      AND NOT c.completion_no_hold) THEN RAISE EXCEPTION 'SDK delivery lacks original call/usage'; END IF;
 ELSE RAISE EXCEPTION 'unsupported compensation delivery'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER economy_delivery_guard BEFORE INSERT ON economy_servicedelivery
FOR EACH ROW EXECUTE FUNCTION economy.guard_delivery();
"""

projection = definition(FOUNDATION, 'economy.project_payable')
projection = projection.replace("    ELSIF NEW.kind='adjustment' THEN", r"""
        IF NEW.delivery_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.economy_servicedelivery d
            WHERE d.id=NEW.delivery_id AND d.admission_id=a.id AND d.allocated_m2z=NEW.allocated_m2z
            AND d.evidence=NEW.basis) THEN RAISE EXCEPTION 'journal delivery mismatch'; END IF;
        IF NEW.delivery_id IS NULL THEN RAISE EXCEPTION 'new service journal requires verified delivery'; END IF;
    ELSIF NEW.kind='adjustment' THEN""")
SQL += projection

usage_guard=definition(FOUNDATION,'economy.guard_usage_transfer').replace(
    '    SELECT * INTO recipient FROM',r"""
    IF NEW.code IN ('purchase','debt_repay') AND EXISTS(SELECT 1 FROM public.ledger_account
       WHERE id=NEW.debit_account_id AND key='sys:clearing_zec') THEN
       -- Stale direct writers may already hold accounts: never wait for the
       -- shared ZEC issuance/retraction fence in that inverted order.
       IF NOT pg_try_advisory_xact_lock(3230929713::bigint) THEN
          RAISE EXCEPTION 'ZEC issuance brake busy; retry' USING ERRCODE='55P03'; END IF;
       IF EXISTS(SELECT 1 FROM public.tuzis_zeccreditreceipt WHERE vanished_at IS NOT NULL
          AND vanish_resolved_at IS NULL) THEN RAISE EXCEPTION 'global_unbacked_credit_brake'; END IF;
    END IF;
    SELECT * INTO recipient FROM""")
SQL+=usage_guard

SQL+=r"""
CREATE FUNCTION economy.guard_note_disposition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE n public.economy_capturedzecnote;r public.tuzis_zeccreditreceipt;cursor public.ledger_purchase_refund;
BEGIN
 NEW.created_at:=statement_timestamp();
 IF NEW.event_key='memo-hydration:'||NEW.note_id::text THEN
  IF NEW.kind<>'observed' OR NOT (NEW.evidence ?& ARRAY['memo_hex','source_kind','source_reference'])
   OR jsonb_typeof(NEW.evidence->'memo_hex') IS DISTINCT FROM 'string'
   OR NOT coalesce(length(NEW.evidence->>'memo_hex')=1024 AND NEW.evidence->>'memo_hex' ~ '^[0-9a-f]+$',false)
   OR coalesce(NEW.evidence->>'source_kind','')='' OR coalesce(NEW.evidence->>'source_reference','')=''
   OR NEW.evidence->>'memo_plain' IS DISTINCT FROM economy.raw_note_memo(NEW.evidence->>'memo_hex')
   OR NOT EXISTS(SELECT 1 FROM public.economy_capturedzecnote WHERE id=NEW.note_id AND memo_hex IS NULL) THEN
   RAISE EXCEPTION 'invalid immutable note hydration'; END IF;
 ELSIF NEW.evidence ? 'memo_hex' OR NEW.evidence ? 'memo_plain' THEN
   RAISE EXCEPTION 'note memo observation requires exact hydration identity';
 END IF;
 IF NEW.kind NOT IN ('issued','legacy_issued') THEN RETURN NEW; END IF;
 SELECT * INTO STRICT n FROM public.economy_capturedzecnote WHERE id=NEW.note_id;
 SELECT * INTO STRICT r FROM public.tuzis_zeccreditreceipt WHERE id=NEW.receipt_id;
 IF (r.txid,r.pool,r.output_index,r.creator_id) IS DISTINCT FROM (n.txid,n.pool,n.output_index,NEW.actor_id)
  OR r.backfilled OR r.amount_zec*100000000<>n.amount_zatoshi OR r.tuzis_credited IS NULL
  OR r.tuzis_credited<=0 THEN RAISE EXCEPTION 'global issuance lacks exact original receipt'; END IF;
 IF NEW.kind='issued' THEN
  IF NOT EXISTS(SELECT 1 FROM public.economy_fundingreservation f JOIN public.purchases_purchaseintent i
     ON i.id=NEW.intent_id WHERE f.id=NEW.funding_id AND f.state='issued' AND f.recipient_id=NEW.actor_id
     AND i.creator_id=NEW.actor_id AND i.rail='zec' AND i.status='credited'
     AND f.id::text=i.quote->>'funding_reservation_id'
     AND f.external_receipt->>'provider_reference'='zec:'||n.txid||':'||n.pool||':'||n.output_index::text) THEN
      RAISE EXCEPTION 'global issuance lacks exact original funding intent'; END IF;
  SELECT * INTO cursor FROM public.ledger_purchase_refund WHERE ref_kind='funding_reservation'
    AND ref_id=NEW.funding_id::text AND rail='zec';
 ELSE
  SELECT * INTO cursor FROM public.ledger_purchase_refund WHERE ref_kind='zec_receipt' AND ref_id=r.id::text AND rail='zec';
 END IF;
 IF cursor.id IS NULL OR cursor.credited_m2z<>r.tuzis_credited*1000 OR NOT EXISTS(
   SELECT 1 FROM public.ledger_account WHERE id=cursor.account_id AND owner_id=NEW.actor_id)
   OR cursor.credited_m2z<>(SELECT coalesce(sum(t.amount),0) FROM public.ledger_transfer t
      JOIN public.ledger_account clearing ON clearing.id=t.debit_account_id AND clearing.key='sys:clearing_zec'
      JOIN public.ledger_account target ON target.id=t.credit_account_id
      WHERE t.ref_kind=cursor.ref_kind AND t.ref_id=cursor.ref_id AND (
        t.code='purchase' AND t.credit_account_id=cursor.account_id OR
        t.code='debt_repay' AND t.meta->>'origin'='purchase' AND target.kind='user_debt' AND target.owner_id=NEW.actor_id)) THEN
   RAISE EXCEPTION 'global issuance lacks exact original journal'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER economy_note_disposition_guard BEFORE INSERT ON economy_zecnotedisposition
FOR EACH ROW EXECUTE FUNCTION economy.guard_note_disposition();
"""

SQL += r"""
CREATE FUNCTION economy.settle_service_delivery(p_admission uuid,p_key text,p_expected_allocated bigint,p_evidence jsonb)
RETURNS bigint LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a public.economy_serviceadmission;d public.economy_servicedelivery;
 buyer bigint;who bigint;joined timestamptz;departed timestamptz;minutes bigint;
 platform record;collected record;requested bigint;basis jsonb;child uuid;entry bigint;group_key text;
BEGIN
 PERFORM economy.policy();
 SELECT * INTO STRICT a FROM public.economy_serviceadmission WHERE id=p_admission;
 IF a.service<>'livestream_ppv' OR a.policy_version<>1 OR p_key IS NULL OR length(p_key)>240
  OR p_evidence->>'provider_session_id' IS DISTINCT FROM a.source->>'provider_session_id'
  OR p_evidence->>'meeting_id' IS DISTINCT FROM a.source->>'meeting_id'
  OR p_evidence->>'participant_id' IS DISTINCT FROM 'ea_'||replace(a.id::text,'-','')
  OR NOT EXISTS(SELECT 1 FROM public.dyte_webhookdelivery w
    WHERE w.provider_event_id::text=p_evidence->>'provider_event_id'
     AND w.business_event_key=p_key AND w.event_type='meeting.participantLeft'
     AND w.payload_sha256=p_evidence->>'payload_sha256') THEN
   RAISE EXCEPTION 'PPV delivery lacks original verified provider evidence'; END IF;
 joined:=(p_evidence->>'joined_at')::timestamptz;departed:=(p_evidence->>'left_at')::timestamptz;
 IF joined IS NULL OR departed IS NULL OR joined<a.admitted_at OR departed<=joined
  OR departed>statement_timestamp() THEN RAISE EXCEPTION 'invalid original PPV interval'; END IF;
 group_key:=(a.source->>'provider_session_id')||':'||(a.source->>'subject_creator_id');
 -- Serialize this provider/viewer cohort before finance locks. The exclusion
 -- constraint also protects direct inserts and cross-admission replays.
 PERFORM pg_advisory_xact_lock(hashtextextended('ppv:'||group_key,0));
 SELECT * INTO d FROM public.economy_servicedelivery WHERE provider_key=p_key;
 IF FOUND THEN
  IF d.admission_id<>a.id OR d.interval<>tstzrange(joined,departed,'[)')
    OR (p_expected_allocated IS NOT NULL AND p_expected_allocated<>d.allocated_m2z) THEN
    RAISE EXCEPTION 'PPV delivery replay identity changed'; END IF;
  SELECT id INTO STRICT entry FROM public.economy_payablejournal WHERE delivery_id=d.id;
  RETURN entry;
 END IF;
 IF EXISTS(SELECT 1 FROM public.economy_servicedelivery WHERE service='livestream_ppv'
   AND cohort=group_key AND interval && tstzrange(joined,departed,'[)')) THEN
   RAISE EXCEPTION 'PPV delivery overlaps previously settled service'; END IF;
 buyer:=(a.source->>'subject_creator_id')::bigint;
 FOR who IN SELECT id FROM public.g12f_creator WHERE id IN (buyer,a.creator_id) ORDER BY id LOOP
  PERFORM ledger.lock_creator(who); END LOOP;
 minutes:=ceil(extract(epoch FROM departed-joined)/60);
 requested:=ceil((a.source->>'price_per_minute_2z')::numeric*minutes)*1000;
 SELECT * INTO platform FROM ledger.spend_up_to(buyer,(minutes/2)*1000,'ppv_platform',p_key);
 SELECT * INTO collected FROM ledger.spend_up_to(buyer,requested,'ppv_service',p_key);
 IF p_expected_allocated IS NOT NULL AND p_expected_allocated<>collected.charged THEN
  RAISE EXCEPTION 'PPV allocation disagrees with exact collected basis'; END IF;
 child:=ledger.uuid_v7();
 basis:=p_evidence||jsonb_build_object('admission_id',a.id,'delivery_reference',p_key,
  'allocation_reference','ppv-service:'||p_key,'creator_transfer_id',collected.transfer_id,
  'platform_transfer_id',platform.transfer_id,'platform_collected_m2z',platform.charged,
  'creator_allocated_m2z',collected.charged,'requested_creator_m2z',requested,
  'duration_minutes',minutes,'price_per_minute_2z',a.source->>'price_per_minute_2z');
 INSERT INTO public.economy_servicedelivery(id,admission_id,service,provider_key,cohort,interval,
  allocated_m2z,evidence,evidence_digest,created_at) VALUES(child,a.id,a.service,p_key,group_key,
  tstzrange(joined,departed,'[)'),collected.charged,basis,
  encode(sha256(convert_to(basis::text,'UTF8')),'hex'),statement_timestamp());
 INSERT INTO public.economy_payablejournal(account_id,admission_id,delivery_id,idempotency_key,kind,
  allocated_m2z,delta_nusd,basis,created_at) VALUES(a.account_id,a.id,child,'ppv-delivery:'||p_key,
  'service',collected.charged,collected.charged*(SELECT nusd_per_allocated_m2z
  FROM public.economy_compensationschedule WHERE id=a.schedule_id),basis,statement_timestamp()) RETURNING id INTO entry;
 RETURN entry;
END $$;

CREATE FUNCTION economy.complete_sdk_delivery(p_hold uuid,p_usage bigint,p_created timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE u public.ledger_ai_usage;x public.economy_sdkserviceadmission;a public.economy_serviceadmission;
 d uuid;b jsonb;
BEGIN
 SELECT * INTO STRICT u FROM public.ledger_ai_usage WHERE id=p_usage AND created_at=p_created;
 SELECT * INTO x FROM public.economy_sdkserviceadmission WHERE call_id::text=u.logical_key;
 IF x.call_id IS NULL THEN
   IF u.developer_m2z<>0 THEN RAISE EXCEPTION 'SDK allocated margin lacks captured supplier'; END IF;
   RETURN;
 END IF;
 IF u.outcome<>'settled' AND NOT (u.outcome='expired' AND u.late_settle_attempted) THEN RETURN; END IF;
 IF EXISTS(SELECT 1 FROM public.economy_servicedelivery WHERE provider_key='sdk:'||p_hold) THEN RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.ledger_gateway_call WHERE id=x.call_id AND completion_meta IS NOT NULL AND NOT completion_no_hold) THEN
   RAISE EXCEPTION 'SDK settlement requires original provider completion'; END IF;
 SELECT * INTO STRICT a FROM public.economy_serviceadmission WHERE id=x.admission_id;
 d:=ledger.uuid_v7();
 b:=jsonb_build_object('admission_id',a.id,'delivery_reference','sdk:'||p_hold,
   'allocation_reference','ledger-usage:'||u.id||':'||u.created_at,'usage_id',u.id,
   'usage_created_at',u.created_at,'provider_usage',u.usage,'charged_m2z',u.charged,
   'provider_m2z',u.provider_m2z,'company_utility_m2z',u.charged-u.provider_m2z,
   'developer_allocated_m2z',u.developer_m2z,'company_subsidy_m2z',greatest(u.provider_m2z-u.charged,0));
 INSERT INTO public.economy_servicedelivery(id,admission_id,service,provider_key,cohort,interval,
   allocated_m2z,evidence,evidence_digest,created_at)
 VALUES(d,a.id,'sdk_application','sdk:'||p_hold,'sdk:'||x.call_id,NULL,u.developer_m2z,b,
   encode(sha256(convert_to(b::text,'UTF8')),'hex'),statement_timestamp());
 INSERT INTO public.economy_payablejournal(account_id,admission_id,delivery_id,idempotency_key,kind,
   allocated_m2z,delta_nusd,basis,created_at)
 VALUES(a.account_id,a.id,d,'sdk-delivery:'||p_hold,'service',u.developer_m2z,
   u.developer_m2z*(SELECT nusd_per_allocated_m2z FROM public.economy_compensationschedule WHERE id=a.schedule_id),
   b,statement_timestamp());
END $$;
"""

finish = definition(LIFECYCLE, 'ledger.finish_hold')
finish = finish.replace('    IF p_provider<>0 OR p_developer<>0 OR u.platform_m2z<>0 THEN', r"""
    IF (SELECT version FROM economy.policy())=1 THEN
        PERFORM economy.complete_sdk_delivery(h.id,u.id,u.created_at);
        IF p_provider>0 THEN
            SELECT * INTO posted FROM ledger.post_transfer(ledger.sys('sys:ai_clearing'),ledger.sys('sys:provider_cost'),
                p_provider,'ai_rollup','hold',h.id::text,'provider:'||h.id,NULL);
            IF posted.status<>'posted' THEN RAISE EXCEPTION 'provider allocation refused'; END IF;
        END IF;
        IF p_charge>p_provider THEN
            SELECT * INTO posted FROM ledger.post_transfer(ledger.sys('sys:ai_clearing'),ledger.sys('sys:platform_revenue'),
                p_charge-p_provider,'ai_rollup','hold',h.id::text,'company:'||h.id,NULL);
            IF posted.status<>'posted' THEN RAISE EXCEPTION 'company allocation refused'; END IF;
        ELSIF p_provider>p_charge THEN
            SELECT * INTO posted FROM ledger.post_transfer(ledger.sys('sys:platform_revenue'),ledger.sys('sys:ai_clearing'),
                p_provider-p_charge,'ai_rollup','hold',h.id::text,'subsidy:'||h.id,NULL);
            IF posted.status<>'posted' THEN RAISE EXCEPTION 'company subsidy refused'; END IF;
        END IF;
        RETURN u;
    END IF;
    IF p_provider<>0 OR p_developer<>0 OR u.platform_m2z<>0 THEN""")
SQL += finish

late = definition(LIFECYCLE,'ledger.settle_internal')
late = late.replace('    terminal_reason text;', '    terminal_reason text;posted record;')
old_late = """                IF provider>0 THEN INSERT INTO public.ledger_ai_split_queue(usage_id,developer_creator_id,provider_m2z,developer_m2z,platform_m2z)
                    VALUES(u.id,(SELECT developer_creator_id FROM public.ledger_app WHERE id=u.app_id),provider,0,-provider);END IF;"""
late = late.replace(old_late,r"""                IF (SELECT version FROM economy.policy())=1 THEN
                    IF provider>0 THEN
                        SELECT * INTO posted FROM ledger.post_transfer(ledger.sys('sys:ai_clearing'),ledger.sys('sys:provider_cost'),
                            provider,'ai_rollup','hold',p_hold_id::text,'provider:'||p_hold_id,NULL);
                        IF posted.status<>'posted' THEN RAISE EXCEPTION 'late provider allocation refused'; END IF;
                        SELECT * INTO posted FROM ledger.post_transfer(ledger.sys('sys:platform_revenue'),ledger.sys('sys:ai_clearing'),
                            provider,'ai_rollup','hold',p_hold_id::text,'subsidy:'||p_hold_id,NULL);
                        IF posted.status<>'posted' THEN RAISE EXCEPTION 'late company subsidy refused'; END IF;
                    END IF;
                    PERFORM economy.complete_sdk_delivery(p_hold_id,u.id,u.created_at);
                ELSE
                    IF provider>0 THEN INSERT INTO public.ledger_ai_split_queue(usage_id,developer_creator_id,provider_m2z,developer_m2z,platform_m2z)
                        VALUES(u.id,(SELECT developer_creator_id FROM public.ledger_app WHERE id=u.app_id),provider,0,-provider);END IF;
                END IF;""")
assert old_late not in late
late=late.replace("        status:='not_open';state:=terminal_reason;priced:=0;", "        IF (SELECT version FROM economy.policy())=1 THEN PERFORM economy.complete_sdk_delivery(p_hold_id,u.id,u.created_at); END IF;\n        status:='not_open';state:=terminal_reason;priced:=0;")
SQL+=late

# Frozen bodies are renamed, not edited. Restrict every public gateway entry
# before it reaches a metadata mutation or legacy finance lock.
FUNCTIONS = [
 ('inquire','uuid,uuid','p_subject uuid,p_app_id uuid','p_subject,p_app_id',
  'TABLE(available bigint,cap_remaining bigint,debt bigint,open_holds integer,frozen boolean)'),
 ('gateway_context','uuid,uuid,integer,integer',
  'p_subject uuid,p_app uuid,p_aep integer,p_agen integer','p_subject,p_app,p_aep,p_agen','jsonb'),
 ('call_claim','uuid,uuid,integer,integer,uuid,text,text,jsonb',
  'p_subject uuid,p_app uuid,p_aep integer,p_agen integer,p_call uuid,p_key text,p_fingerprint text,p_request jsonb',
  'p_subject,p_app,p_aep,p_agen,p_call,p_key,p_fingerprint,p_request',
  'TABLE(status text,call_id uuid,record jsonb,context jsonb)'),
 ('call_read','uuid,uuid,integer,integer,uuid',
  'p_subject uuid,p_app uuid,p_aep integer,p_agen integer,p_call uuid',
  'p_subject,p_app,p_aep,p_agen,p_call','TABLE(status text,record jsonb)'),
 ('call_complete','uuid,uuid,integer,integer,uuid,jsonb,boolean',
  "p_subject uuid,p_app uuid,p_aep integer,p_agen integer,p_call uuid,p_completion jsonb,p_no_hold boolean DEFAULT false",
  'p_subject,p_app,p_aep,p_agen,p_call,p_completion,p_no_hold','TABLE(status text,record jsonb)'),
 ('hold','uuid,uuid,bigint,text,text,integer,integer,integer,integer,text,bigint,text,integer,jsonb',
  "p_subject uuid,p_app_id uuid,p_amount bigint,p_hold_key text,p_logical_key text,p_attempt integer DEFAULT 0,p_ttl_s integer DEFAULT 300,p_account_epoch integer DEFAULT NULL,p_grant_generation integer DEFAULT NULL,p_model_id text DEFAULT NULL,p_rate_card_version bigint DEFAULT NULL,p_catalog_version text DEFAULT NULL,p_markup_bps integer DEFAULT 0,p_meta jsonb DEFAULT '{}'",
  'p_subject,p_app_id,p_amount,p_hold_key,p_logical_key,p_attempt,p_ttl_s,p_account_epoch,p_grant_generation,p_model_id,p_rate_card_version,p_catalog_version,p_markup_bps,p_meta',
  'TABLE(hold_id uuid,status text,state text,available bigint,cap_remaining bigint,expires_at timestamptz,amount bigint,applied_markup_bps integer)'),
 ('extend','uuid,bigint,integer,integer,integer',
  'p_hold_id uuid,p_amount_to bigint DEFAULT NULL,p_ttl_s integer DEFAULT 300,p_account_epoch integer DEFAULT NULL,p_grant_generation integer DEFAULT NULL',
  'p_hold_id,p_amount_to,p_ttl_s,p_account_epoch,p_grant_generation',
  'TABLE(status text,state text,amount bigint,expires_at timestamptz,available bigint,cap_remaining bigint)'),
 ('settle','uuid,bigint,jsonb',"p_hold_id uuid,p_cost_nusd bigint,p_usage jsonb DEFAULT '{}'",
  'p_hold_id,p_cost_nusd,p_usage',
  'TABLE(status text,state text,priced bigint,charged bigint,shortfall bigint,transfer_id bigint,available bigint,cap_remaining bigint)'),
 ('release','uuid,jsonb',"p_hold_id uuid,p_usage jsonb DEFAULT '{}'",'p_hold_id,p_usage',
  'TABLE(status text,state text,available bigint)'),
]
for name, signature, params, args, returns in FUNCTIONS:
    before = ''
    after = ''
    if name == 'call_claim':
        before = 'IF v=1 THEN PERFORM economy.lock_sdk_parties(p_subject,p_app); END IF;'
        # RETURN QUERY stores the result; the immutable new claim is admitted
        # in this same transaction before the gateway may perform provider IO.
        after = """IF v=1 AND EXISTS(SELECT 1 FROM public.ledger_gateway_call WHERE id=p_call
          AND created_at=transaction_timestamp()) AND NOT EXISTS(SELECT 1 FROM public.economy_sdkserviceadmission x WHERE x.call_id=p_call) THEN
          PERFORM economy.admit_sdk_call(p_subject,p_app,p_call,p_aep,p_agen); END IF;"""
    if name == 'hold':
        before = """IF v=1 THEN
          PERFORM economy.lock_sdk_parties(p_subject,p_app_id);
          IF EXISTS(SELECT 1 FROM ledger.gateway_identity(p_subject,p_app_id,p_account_epoch,p_grant_generation) WHERE effective_markup_bps>0)
            AND NOT EXISTS(SELECT 1 FROM public.economy_sdkserviceadmission x JOIN public.ledger_gateway_call c ON c.id=x.call_id
              JOIN public.ledger_account a ON a.id=c.account_id WHERE c.id::text=p_logical_key
              AND c.app_id=p_app_id AND a.owner_id=x.subject_id
              AND a.owner_id=(SELECT id FROM public.g12f_creator WHERE public_id=p_subject)) THEN
            RAISE EXCEPTION 'SDK positive hold lacks original supplier admission'; END IF;
          IF EXISTS(SELECT 1 FROM public.economy_sdkserviceadmission x
            JOIN public.economy_serviceadmission original ON original.id=x.admission_id
            JOIN public.economy_supplierofferapproval o ON o.id=x.offer_id
            CROSS JOIN ledger.gateway_identity(p_subject,p_app_id,p_account_epoch,p_grant_generation) current_quote
            WHERE x.call_id::text=p_logical_key AND (
              current_quote.effective_markup_bps>o.markup_bps
              OR current_quote.effective_markup_bps<>(original.source->>'effective_markup_bps')::integer
              OR o.creator_id IS DISTINCT FROM (SELECT developer_creator_id FROM public.ledger_app WHERE id=p_app_id))) THEN
            RAISE EXCEPTION 'SDK quote exceeds or changes original supplier offer'; END IF;
          END IF;"""
    if name in {'extend','settle','release'}:
        before = 'IF v=1 THEN PERFORM economy.lock_sdk_hold_parties(p_hold_id); END IF;'
    action = f'RETURN QUERY SELECT * FROM ledger.{name}_economic_v0({args});'
    if returns == 'jsonb':
        action = f'RETURN ledger.{name}_economic_v0({args});'
    SQL += f"""
ALTER FUNCTION ledger.{name}({signature}) RENAME TO {name}_economic_v0;
CREATE FUNCTION ledger.{name}({params}) RETURNS {returns}
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v integer;
BEGIN v:=ledger.assert_economic_prepared(); {before} {action} {after} END $$;
"""

for table in ('supplierofferapproval','supplierofferrevocation','sdkserviceadmission','servicedelivery','capturedzecnote','zecnotedisposition'):
    SQL += f'CREATE TRIGGER economy_{table}_immutable BEFORE UPDATE OR DELETE ON economy_{table} FOR EACH ROW EXECUTE FUNCTION economy.immutable_record();\n'
SQL += """
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA economy FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ledger FROM PUBLIC;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='ledger' AND p.proname LIKE '%_economic_v0' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f.signature,ledger.gateway_role_name());
 END LOOP;
END $$;
"""
configure = definition(LIFECYCLE, 'ledger.configure_gateway_role').replace(
    "'ledger.call_read(uuid,uuid,integer,integer,uuid)'", 
    "'ledger.call_read(uuid,uuid,integer,integer,uuid)', 'ledger.prepare_economic_policy(integer,integer)'")
SQL += configure + '\nSELECT ledger.configure_gateway_role();\n'
# Role names are database-specific, so emit exact grant signatures dynamically.
for name, signature, *_ in FUNCTIONS:
    SQL += f"DO $$ BEGIN EXECUTE format('GRANT EXECUTE ON FUNCTION ledger.{name}({signature}) TO %I',ledger.gateway_role_name()); END $$;\n"
SQL += "DO $$ BEGIN EXECUTE format('GRANT EXECUTE ON FUNCTION ledger.prepare_economic_policy(integer,integer) TO %I',ledger.gateway_role_name()); END $$;\n"

SQL += r"""
CREATE FUNCTION economy.activation_blockers(p_manifest jsonb) RETURNS text[]
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE blockers text[]:='{}'; item jsonb;lane text;
BEGIN
 IF p_manifest->>'manifest_version' IS DISTINCT FROM 'economic-cutover-v1'
  OR p_manifest->'policy_version' IS DISTINCT FROM '1'::jsonb
  OR NOT coalesce(p_manifest->>'environment' IN ('stage','prod'),false)
  OR p_manifest->>'current_database' IS DISTINCT FROM current_database()
  OR NOT coalesce(p_manifest->>'release_commit' ~ '^[0-9a-f]{40}$',false)
  OR NOT coalesce(p_manifest->>'writer_registry_digest' ~ '^[0-9a-f]{64}$',false)
  OR NOT coalesce(p_manifest->>'source_capture_sha256' ~ '^[0-9a-f]{64}$',false)
  OR NOT (p_manifest ?& ARRAY['operator','decision_reference','observed_at','source_capture_reference','rollout_reference','drain_reference'])
  OR EXISTS(SELECT 1 FROM unnest(ARRAY['operator','decision_reference','source_capture_reference','rollout_reference','drain_reference']) k
    WHERE coalesce(p_manifest->>k,'')='') THEN blockers:=array_append(blockers,'reviewed_cutover_manifest_required'); END IF;
 BEGIN
  IF NOT coalesce((p_manifest->>'observed_at')::timestamptz BETWEEN statement_timestamp()-interval '30 minutes' AND statement_timestamp(),false)
   OR NOT coalesce(p_manifest->>'observed_at' ~ '(Z|\+00:00)$',false) THEN
    blockers:=array_append(blockers,'fresh_utc_observation_required'); END IF;
 EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN blockers:=array_append(blockers,'fresh_utc_observation_required'); END;
 IF p_manifest->'writers'->'django'->>'loaded_revision' IS DISTINCT FROM p_manifest->>'release_commit' THEN
  blockers:=array_append(blockers,'django_loaded_revision_required'); END IF;
 FOREACH lane IN ARRAY ARRAY['image-variant-worker','media-worker','translation-worker','recording-worker',
    'billing-worker','exports-worker','outbox-worker','ledger-worker','comment-aiscore'] LOOP
  IF (p_manifest->'writers'->'worker_lanes'->lane->'verified_zero_and_drained' IS DISTINCT FROM 'true'::jsonb) AND
   p_manifest->'writers'->'worker_lanes'->lane->>'loaded_revision' IS DISTINCT FROM p_manifest->>'release_commit'
   OR coalesce(p_manifest->'writers'->'worker_lanes'->lane->>'verification_reference','')='' THEN
   blockers:=array_append(blockers,'worker_loaded_revision_required:'||lane); END IF;
 END LOOP;
 item:=p_manifest->'writers'->'gateway';
 IF NOT coalesce(item->>'image_digest' ~ '^sha256:[0-9a-f]{64}$',false)
  OR NOT coalesce(item->>'oci_revision' ~ '^[0-9a-f]{40}$',false)
  OR item->'executable_function_count' IS DISTINCT FROM '10'::jsonb
  OR coalesce(item->>'restricted_login_verification_reference','')='' THEN
   blockers:=array_append(blockers,'gateway_deployment_and_login_proof_required'); END IF;
 item:=p_manifest->'writers'->'zec_producer';
 IF item->>'loaded_revision' IS DISTINCT FROM p_manifest->>'release_commit'
  OR NOT coalesce(item->>'mode'='legacy',false)
  OR EXISTS(SELECT 1 FROM unnest(ARRAY['single_owner_reference','source_reference','mode_reference']) k WHERE coalesce(item->>k,'')='') THEN
   blockers:=array_append(blockers,'zec_producer_deployment_and_owner_proof_required'); END IF;
 IF NOT EXISTS(SELECT 1 FROM public.ledger_config WHERE id AND writer_boundary AND dual_write AND NOT heal_enabled) THEN
  blockers:=array_append(blockers,'true_writer_boundary_required'); END IF;
 IF EXISTS(SELECT 1 FROM public.ledger_gateway_call c WHERE c.phase='streaming' OR c.phase='settling' AND NOT EXISTS(SELECT 1 FROM public.ledger_ai_usage u WHERE u.logical_key=c.id::text AND u.outcome IN ('settled','released','expired'))) THEN blockers:=array_append(blockers,'pending_gateway_claims'); END IF;
 IF EXISTS(SELECT 1 FROM public.ledger_hold) THEN blockers:=array_append(blockers,'active_holds'); END IF;
 IF EXISTS(SELECT 1 FROM public.tuzis_providerreservation WHERE status='active') THEN blockers:=array_append(blockers,'legacy_reservations'); END IF;
 IF EXISTS(SELECT 1 FROM public.ledger_ai_split_queue) OR EXISTS(SELECT 1 FROM public.ledger_dev_markup_pending) THEN
  blockers:=array_append(blockers,'legacy_sdk_split_liabilities'); END IF;
 IF EXISTS(SELECT 1 FROM public.g12f_creator c LEFT JOIN public.ledger_account a ON a.kind='user' AND a.owner_id=c.id
   WHERE a.id IS NULL AND c.tuzis<>0 OR a.id IS NOT NULL AND (a.balance<>c.tuzis*1000 OR a.balance<a.held)) THEN
  blockers:=array_append(blockers,'usage_projection_discrepancy'); END IF;
 IF EXISTS(SELECT 1 FROM public.economy_creatorpayable a WHERE a.balance_nusd<>(SELECT coalesce(sum(delta_nusd),0)
   FROM public.economy_payablejournal j WHERE j.account_id=a.id) OR a.held_nusd<>(SELECT coalesce(sum(amount_nusd),0)
   FROM public.economy_paymentrequest r WHERE r.account_id=a.id AND r.state IN ('requested','approved','signing','broadcast_unknown','broadcast'))) THEN
  blockers:=array_append(blockers,'payable_projection_discrepancy'); END IF;
 IF EXISTS(SELECT 1 FROM public.ledger_account a WHERE a.kind='user' AND a.balance>200000000 AND NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements(coalesce(p_manifest->'preserved_legacy_allowances','[]'::jsonb)) d
   WHERE d->>'account_id'=a.id::text AND d->>'classification'='internal_test_or_promo'
    AND d->'no_new_loading'='true'::jsonb AND coalesce(d->>'source_reference','')<>'' AND coalesce(d->>'decision_reference','')<>'')) THEN
  blockers:=array_append(blockers,'unclassified_over_limit_usage_accounts'); END IF;
 IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('ledger','economy')
   AND has_function_privilege(ledger.gateway_role_name(),p.oid,'EXECUTE'))<>10
  OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('ledger','economy')
   AND has_function_privilege(ledger.gateway_role_name(),p.oid,'EXECUTE') AND p.oid NOT IN (__EXPECTED_ABIS__)) THEN
  blockers:=array_append(blockers,'gateway_function_scope_mismatch'); END IF;
 RETURN blockers;
END $$;
CREATE OR REPLACE FUNCTION economy.guard_policy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE blockers text[];
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'economic policy cannot be deleted'; END IF;
 IF TG_OP='INSERT' AND NEW.version<>0 THEN RAISE EXCEPTION 'policy must start disabled'; END IF;
 IF TG_OP='UPDATE' AND NEW.version IS DISTINCT FROM OLD.version THEN
  IF OLD.version<>0 OR NEW.version<>1 THEN RAISE EXCEPTION 'economic activation is irreversible'; END IF;
  blockers:=economy.activation_blockers(NEW.manifest);
  IF cardinality(blockers)>0 THEN RAISE EXCEPTION 'activation unavailable: %',array_to_string(blockers,',') USING ERRCODE='23514'; END IF;
  NEW.activated_at:=statement_timestamp();
 END IF;
 IF TG_OP='UPDATE' AND OLD.version=1 AND (NEW.manifest IS DISTINCT FROM OLD.manifest OR NEW.activated_at IS DISTINCT FROM OLD.activated_at) THEN
  RAISE EXCEPTION 'original activation evidence immutable'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA economy FROM PUBLIC;
"""

SQL=SQL.replace('__EXPECTED_ABIS__',','.join("to_regprocedure('ledger."+name+'('+signature+")')"
    for name,signature,*_ in FUNCTIONS)+",to_regprocedure('ledger.prepare_economic_policy(integer,integer)')")

REVERSE = r"""
SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='60s';
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM economy_supplierofferapproval) OR EXISTS(SELECT 1 FROM economy_servicedelivery)
 OR EXISTS(SELECT 1 FROM economy_capturedzecnote) OR EXISTS(SELECT 1 FROM economy_sdkserviceadmission)
 OR EXISTS(SELECT 1 FROM economy_zecnotedisposition)
 OR EXISTS(SELECT 1 FROM economy_economicpolicy WHERE version<>0)
 OR EXISTS(SELECT 1 FROM economy_serviceadmission WHERE policy_version=1)
 OR EXISTS(SELECT 1 FROM economy_paymentrequest) THEN RAISE EXCEPTION 'economic integration history prevents reversal'; END IF;
END $$;
"""
for name, signature, *_ in reversed(FUNCTIONS):
    REVERSE += f'DROP FUNCTION ledger.{name}({signature}); ALTER FUNCTION ledger.{name}_economic_v0({signature}) RENAME TO {name};\n'
REVERSE += definition(FOUNDATION,'economy.guard_policy')
REVERSE += definition(FOUNDATION, 'economy.guard_admission') + definition(FOUNDATION, 'economy.project_payable') + definition(LIFECYCLE, 'ledger.finish_hold') + definition(LIFECYCLE,'ledger.settle_internal')
REVERSE += definition(FOUNDATION, 'economy.guard_payment') + definition(LIFECYCLE, 'ledger.configure_gateway_role') + '\nSELECT ledger.configure_gateway_role();\n'
REVERSE+=definition(FOUNDATION,'economy.guard_usage_transfer')
REVERSE += r"""
DROP TRIGGER economy_payment_discharge_check ON economy_paymentrequest;
DROP TRIGGER economy_journal_discharge_check ON economy_payablejournal;
DROP TRIGGER economy_note_disposition_guard ON economy_zecnotedisposition;
DROP FUNCTION economy.guard_note_disposition();
DROP FUNCTION economy.check_payment_discharge(),economy.activation_blockers(jsonb);
DROP TRIGGER economy_captured_note_guard ON economy_capturedzecnote;
DROP TRIGGER economy_note_observation_identity ON tuzis_idempotencykey;
DROP TRIGGER economy_supplier_offer_guard ON economy_supplierofferapproval;
DROP TRIGGER economy_offer_revocation_guard ON economy_supplierofferrevocation;
DROP TRIGGER economy_sdk_binding_guard ON economy_sdkserviceadmission;
DROP TRIGGER economy_delivery_guard ON economy_servicedelivery;
DROP FUNCTION economy.guard_captured_note(),economy.guard_note_observation_identity(),economy.guard_supplier_offer(),economy.guard_offer_revocation(),
 economy.effective_note_memo(uuid),economy.raw_note_memo(text),economy.memo_json_strings_storable(json),economy.guard_sdk_binding(),economy.guard_delivery(),economy.lock_sdk_parties(uuid,uuid),
 economy.admit_sdk_call(uuid,uuid,uuid,integer,integer),economy.lock_sdk_hold_parties(uuid),
 economy.complete_sdk_delivery(uuid,bigint,timestamptz),economy.settle_service_delivery(uuid,text,bigint,jsonb);
DROP FUNCTION ledger.prepare_economic_policy(integer,integer),ledger.assert_economic_prepared();
"""
