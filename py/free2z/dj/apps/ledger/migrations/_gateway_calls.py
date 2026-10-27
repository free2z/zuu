"""Private provisional gateway metadata ABI; see #2254. No balance table grants.

Frozen: used only by migration 0004_gateway_calls. The ``call_read``,
``call_claim`` and ``call_complete`` bodies below are superseded by
``0005_call_recovery`` (``_call_recovery.py``, #2295); change them there.
"""
SQL = r"""
CREATE FUNCTION ledger.gateway_identity(p_subject uuid,p_app uuid,p_aep integer,p_agen integer)
RETURNS TABLE(account_id bigint,consented_markup_bps integer,effective_markup_bps integer,app_frozen boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
SELECT a.id,c.markup_bps,least(c.markup_bps,app.markup_bps,coalesce(app.approved_markup_bps,0)),app.frozen
FROM public.g12f_creator u JOIN public.ledger_account a ON a.owner_id=u.id AND a.kind='user'
JOIN public.ledger_spend_cap c ON c.account_id=a.id AND c.app_id=p_app
JOIN public.ledger_app app ON app.id=c.app_id
WHERE u.public_id=p_subject AND u.is_active AND u.kt_account_epoch=p_aep
AND c.grant_generation=p_agen AND c.revoked_at IS NULL
AND p_app<>'00000000-0000-4000-8000-000000000001'::uuid $$;

CREATE FUNCTION ledger.gateway_context(p_subject uuid,p_app uuid,p_aep integer,p_agen integer)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
SELECT ledger.assert_gateway_database();
SELECT coalesce((SELECT jsonb_build_object('status','ok','available_milli_2z',b.available,
 'cap_remaining_milli_2z',b.cap_remaining,'debt_milli_2z',b.debt,'open_holds',b.open_holds,
 'frozen',b.frozen OR i.app_frozen,'consented_markup_bps',i.consented_markup_bps,
 'effective_markup_bps',i.effective_markup_bps)
 FROM ledger.gateway_identity(p_subject,p_app,p_aep,p_agen) i
 CROSS JOIN ledger.inquire(p_subject,p_app) b),jsonb_build_object('status','revoked')) $$;

CREATE FUNCTION ledger.gateway_metadata_valid(p_value jsonb,p_completion boolean) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE k text;v jsonb;
BEGIN
 IF p_value IS NULL OR jsonb_typeof(p_value)<>'object' OR octet_length(p_value::text)>65536 THEN RETURN false;END IF;
 FOR k,v IN SELECT * FROM jsonb_each(p_value) LOOP
   IF k=ANY(CASE WHEN p_completion THEN ARRAY['model','provider','finish_reason','usage_source']
                ELSE ARRAY['model','requested_model','provider'] END) THEN
     IF jsonb_typeof(v)<>'string' OR length(v#>>'{}') NOT BETWEEN 1 AND 256 THEN RETURN false;END IF;
   ELSIF k='metadata' AND NOT p_completion THEN
     IF jsonb_typeof(v)<>'object' THEN RETURN false;END IF;
     IF (SELECT count(*) FROM jsonb_each(v))>16 OR EXISTS(SELECT 1 FROM jsonb_each(v) x
       WHERE length(x.key)>64 OR jsonb_typeof(x.value)<>'string' OR length(x.value#>>'{}')>256) THEN RETURN false;END IF;
   ELSIF k='catalog_version' AND NOT p_completion THEN
     IF jsonb_typeof(v)<>'number' OR (v#>>'{}')!~'^[0-9]{1,19}$' OR (v#>>'{}')::numeric>9223372036854775807 THEN RETURN false;END IF;
   ELSIF k='partial' AND p_completion THEN
     IF jsonb_typeof(v)<>'boolean' THEN RETURN false;END IF;
   ELSIF k='usage' AND p_completion THEN
     IF jsonb_typeof(v)<>'object' THEN RETURN false;END IF;
     IF EXISTS(SELECT 1 FROM jsonb_each(v) x WHERE x.key<>ALL(ARRAY['input_tokens','cached_input_tokens',
       'cache_write_tokens','output_tokens','reasoning_tokens','images','tool_calls','cache_write_1h_tokens'])
       OR jsonb_typeof(x.value)<>'number' OR (x.value#>>'{}')!~'^[0-9]{1,19}$') THEN RETURN false;END IF;
   ELSIF k='error' AND p_completion THEN
     IF v<>'null'::jsonb THEN
       IF jsonb_typeof(v)<>'object' THEN RETURN false;END IF;
       IF NOT (v ? 'code' AND v ? 'message') OR EXISTS(SELECT 1 FROM jsonb_each(v) x
         WHERE x.key NOT IN ('code','message') OR jsonb_typeof(x.value)<>'string'
         OR length(x.value#>>'{}') NOT BETWEEN 1 AND 256) THEN RETURN false;END IF;
     END IF;
   ELSE RETURN false;
   END IF;
 END LOOP;
 IF NOT p_completion AND NOT (p_value ?& ARRAY['model','requested_model','provider','catalog_version','metadata']) THEN RETURN false;END IF;
 RETURN true;
END $$;

-- Private raw envelope: Rust maps this to the public DTO. Monetary fields
-- are read from ledger usage, never accepted from call_complete metadata.
CREATE FUNCTION ledger.call_envelope(p_call uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
WITH c AS (SELECT * FROM public.ledger_gateway_call WHERE id=p_call),
 u AS (SELECT x.* FROM c JOIN public.ledger_gateway_attempt a ON a.call_id=c.id
   JOIN public.ledger_ai_usage x ON x.hold_id=a.hold_id WHERE x.account_id=c.account_id
   AND x.app_id=c.app_id AND x.created_at>=c.created_at-interval '1 hour'
   ORDER BY (x.outcome='settled') DESC,x.created_at DESC,x.id DESC LIMIT 1),
 h AS (SELECT x.* FROM public.ledger_hold x,c WHERE x.account_id=c.account_id
   AND x.app_id=c.app_id AND x.logical_key=c.id::text),
 state AS (SELECT CASE WHEN u.outcome='settled' THEN
     CASE WHEN coalesce((c.completion_meta->>'partial')::boolean,false) THEN 'settled_partial' ELSE 'settled' END
   WHEN EXISTS(SELECT 1 FROM h) THEN c.phase
   WHEN u.outcome='expired' OR c.phase='released' OR (c.phase='settling' AND u.outcome='released') THEN 'released'
   ELSE c.phase END AS status FROM c LEFT JOIN u ON true)
SELECT jsonb_build_object('call_id',c.id,'status',state.status,'request',c.request_meta,
 'completion',c.completion_meta,'created_at',c.created_at,
 'settled_at',CASE WHEN state.status IN ('settled','settled_partial','released') THEN coalesce(u.created_at,c.completed_at) END,
 'error',CASE WHEN state.status='released' AND u.outcome='expired' THEN
   jsonb_build_object('code','unavailable','message','hold expired unsettled')
   WHEN state.status='released' AND c.completion_meta IS NULL THEN
   jsonb_build_object('code','unavailable','message','call abandoned before completion') ELSE c.completion_meta->'error' END,
 'attempts',coalesce((SELECT jsonb_agg(a.snapshot ORDER BY a.hold_id)
   FROM public.ledger_gateway_attempt a WHERE a.call_id=c.id),'[]'::jsonb),
 'settlement',CASE WHEN u.id IS NULL THEN NULL ELSE jsonb_build_object('hold_id',u.hold_id,
   'outcome',u.outcome,'hold_milli_2z',u.hold_amount,'priced_milli_2z',u.priced,
   'collected_milli_2z',u.charged,'shortfall_milli_2z',u.shortfall,'transfer_id',u.transfer_id,
   'usage',u.usage,'model',u.model_id,'applied_markup_bps',u.dev_markup_bps) END)
FROM c CROSS JOIN state LEFT JOIN u ON true $$;

CREATE FUNCTION ledger.call_read(p_subject uuid,p_app uuid,p_aep integer,p_agen integer,p_call uuid)
RETURNS TABLE(status text,record jsonb) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
SELECT ledger.assert_gateway_database();
SELECT CASE WHEN i.account_id IS NULL THEN 'revoked' WHEN c.id IS NULL THEN 'not_found' ELSE 'found' END,
 CASE WHEN c.id IS NOT NULL THEN ledger.call_envelope(c.id) END
FROM (SELECT 1) seed LEFT JOIN ledger.gateway_identity(p_subject,p_app,p_aep,p_agen) i ON true
LEFT JOIN public.ledger_gateway_call c ON c.id=p_call AND c.account_id=i.account_id AND c.app_id=p_app
 AND c.created_at>=now()-interval '90 days' $$;

CREATE FUNCTION ledger.call_claim(p_subject uuid,p_app uuid,p_aep integer,p_agen integer,
 p_call uuid,p_key text,p_fingerprint text,p_request jsonb)
RETURNS TABLE(status text,call_id uuid,record jsonb,context jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE account bigint;existing public.ledger_gateway_call;key_call uuid;
BEGIN
 PERFORM ledger.assert_gateway_database();
 IF p_call IS NULL OR substring(p_call::text,15,1)<>'7' OR substring(p_call::text,20,1) NOT IN ('8','9','a','b')
    OR p_fingerprint IS NULL OR p_fingerprint!~'^[0-9a-f]{64}$'
    OR (p_key IS NOT NULL AND (length(p_key) NOT BETWEEN 1 AND 128 OR p_key!~'^[!-~]+$'))
    OR NOT ledger.gateway_metadata_valid(p_request,false) THEN
   RAISE EXCEPTION 'invalid gateway call claim' USING ERRCODE='22023';END IF;
 PERFORM ledger.lock_creator((SELECT id FROM public.g12f_creator WHERE public_id=p_subject));
 SELECT i.account_id INTO account FROM ledger.gateway_identity(p_subject,p_app,p_aep,p_agen) i;
 context:=ledger.gateway_context(p_subject,p_app,p_aep,p_agen);
 IF account IS NULL THEN status:='revoked';RETURN NEXT;RETURN;END IF;
 SELECT * INTO existing FROM public.ledger_gateway_call c WHERE c.id=p_call;
 IF FOUND AND (existing.account_id<>account OR existing.app_id<>p_app) THEN
   status:='conflict';RETURN NEXT;RETURN;END IF;
 IF existing.id IS NULL AND p_key IS NOT NULL THEN
   SELECT k.call_id INTO key_call FROM public.ledger_gateway_idempotency k
   WHERE k.account_id=account AND k.app_id=p_app AND k.key=p_key AND k.expires_at>now();
   IF FOUND THEN SELECT * INTO existing FROM public.ledger_gateway_call WHERE id=key_call;END IF;
 END IF;
 IF existing.id IS NOT NULL THEN
   call_id:=existing.id;
   IF existing.fingerprint<>p_fingerprint
     OR existing.request_meta->'metadata' IS DISTINCT FROM p_request->'metadata'
     OR existing.request_meta->'requested_model' IS DISTINCT FROM p_request->'requested_model' THEN status:='conflict';
   ELSIF existing.created_at<now()-interval '90 days' THEN status:='not_found';
   ELSE
     record:=ledger.call_envelope(existing.id);
     status:=CASE WHEN record->>'status' IN ('settled','settled_partial','released') THEN 'replayed' ELSE 'pending' END;
   END IF;
   RETURN NEXT;RETURN;
 END IF;
 INSERT INTO public.ledger_gateway_call(id,account_id,app_id,account_epoch,grant_generation,
   fingerprint,phase,request_meta,created_at,expires_at)
 VALUES(p_call,account,p_app,p_aep,p_agen,p_fingerprint,'streaming',p_request,now(),now()+interval '300 seconds');
 IF p_key IS NOT NULL THEN
   INSERT INTO public.ledger_gateway_idempotency(account_id,app_id,key,call_id,expires_at)
   VALUES(account,p_app,p_key,p_call,now()+interval '24 hours')
   ON CONFLICT(account_id,app_id,key) DO UPDATE SET call_id=EXCLUDED.call_id,expires_at=EXCLUDED.expires_at;
 END IF;
 status:='claimed';call_id:=p_call;record:=ledger.call_envelope(p_call);RETURN NEXT;
END $$;

-- Existing work may complete after revocation. Compare captured admission
-- epochs here, rather than authorizing a fresh grant or a fresh hold.
CREATE FUNCTION ledger.call_complete(p_subject uuid,p_app uuid,p_aep integer,p_agen integer,
 p_call uuid,p_completion jsonb,p_no_hold boolean DEFAULT false)
RETURNS TABLE(status text,record jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.ledger_gateway_call;owner bigint;
BEGIN
 PERFORM ledger.assert_gateway_database();
 IF NOT ledger.gateway_metadata_valid(p_completion,true) OR p_no_hold IS NULL THEN
   RAISE EXCEPTION 'invalid gateway call completion' USING ERRCODE='22023';END IF;
 SELECT id INTO owner FROM public.g12f_creator WHERE public_id=p_subject;
 PERFORM ledger.lock_creator(owner);
 SELECT x.* INTO c FROM public.ledger_gateway_call x JOIN public.ledger_account a ON a.id=x.account_id
 WHERE x.id=p_call AND x.app_id=p_app AND a.owner_id=owner
   AND x.account_epoch=p_aep AND x.grant_generation=p_agen AND x.created_at>=now()-interval '90 days' FOR UPDATE OF x;
 IF NOT FOUND THEN status:='not_found';RETURN NEXT;RETURN;END IF;
 IF c.completion_meta IS NOT NULL THEN
   status:=CASE WHEN c.completion_meta=p_completion AND c.completion_no_hold=p_no_hold THEN 'replayed' ELSE 'conflict' END;
 ELSIF p_no_hold AND EXISTS(SELECT 1 FROM public.ledger_gateway_attempt WHERE call_id=p_call) THEN status:='conflict';
 ELSE
   UPDATE public.ledger_gateway_call SET completion_meta=p_completion,completion_no_hold=p_no_hold,completed_at=now(),
     phase=CASE WHEN p_no_hold OR c.phase='released' THEN 'released' ELSE 'settling' END WHERE id=p_call;
   status:='recorded';
 END IF;
 record:=ledger.call_envelope(p_call);RETURN NEXT;
END $$;

CREATE FUNCTION ledger.gateway_attempt_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.ledger_gateway_call;
BEGIN
 IF NEW.logical_key!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN NEW;END IF;
 SELECT * INTO c FROM public.ledger_gateway_call WHERE id=NEW.logical_key::uuid FOR UPDATE;
 IF NOT FOUND THEN RETURN NEW;END IF;
 IF c.account_id<>NEW.account_id OR c.app_id<>NEW.app_id THEN
   RAISE EXCEPTION 'gateway attempt scope mismatch';END IF;
 IF TG_OP='INSERT' AND c.phase<>'streaming' THEN RAISE EXCEPTION 'gateway call no longer accepting attempts';END IF;
 IF NEW.meta ? 'provider' AND (jsonb_typeof(NEW.meta->'provider')<>'string'
   OR length(NEW.meta->>'provider') NOT BETWEEN 1 AND 256) THEN
   RAISE EXCEPTION 'invalid gateway attempt provider' USING ERRCODE='22023';END IF;
 INSERT INTO public.ledger_gateway_attempt(hold_id,call_id,snapshot)
 VALUES(NEW.id,c.id,jsonb_build_object('hold_id',NEW.id,'attempt',NEW.attempt,'model',NEW.model_id,
   'provider',coalesce(NEW.meta->'provider',c.request_meta->'provider'),'catalog_version',NEW.catalog_version,'rate_card_id',NEW.rate_card_id,
   'hold_milli_2z',NEW.amount,'applied_markup_bps',NEW.dev_markup_bps,'expires_at',NEW.expires_at))
 ON CONFLICT(hold_id) DO UPDATE SET snapshot=EXCLUDED.snapshot;
 UPDATE public.ledger_gateway_call SET expires_at=greatest(expires_at,NEW.expires_at) WHERE id=c.id;
 RETURN NEW;
END $$;
CREATE TRIGGER gateway_attempt_snapshot AFTER INSERT OR UPDATE ON public.ledger_hold
 FOR EACH ROW EXECUTE FUNCTION ledger.gateway_attempt_snapshot();

CREATE FUNCTION ledger.gateway_expired_call() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.outcome='expired' AND NOT EXISTS(SELECT 1 FROM public.ledger_hold h
   WHERE h.logical_key=NEW.logical_key AND h.account_id=NEW.account_id AND h.app_id=NEW.app_id) THEN
   UPDATE public.ledger_gateway_call SET phase='released',completed_at=coalesce(completed_at,now())
   WHERE id=(SELECT call_id FROM public.ledger_gateway_attempt WHERE hold_id=NEW.hold_id)
     AND account_id=NEW.account_id AND app_id=NEW.app_id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gateway_expired_call AFTER INSERT ON public.ledger_ai_usage
 FOR EACH ROW EXECUTE FUNCTION ledger.gateway_expired_call();

-- Bounded metadata-only cleanup. Never remove an economic receipt or hold.
CREATE FUNCTION ledger.cleanup_gateway_calls(p_limit integer DEFAULT 100) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.ledger_gateway_call;n integer:=0;
BEGIN
 FOR c IN SELECT x.* FROM public.ledger_gateway_call x WHERE
   (x.created_at<now()-interval '90 days' OR (x.phase IN ('streaming','settling') AND x.expires_at<now()))
   AND NOT EXISTS(SELECT 1 FROM public.ledger_hold h WHERE h.logical_key=x.id::text
     AND h.account_id=x.account_id AND h.app_id=x.app_id)
   ORDER BY x.created_at LIMIT greatest(0,least(p_limit,1000)) FOR UPDATE OF x SKIP LOCKED LOOP
   IF c.created_at<now()-interval '90 days' THEN
     DELETE FROM public.ledger_gateway_idempotency WHERE call_id=c.id;
     DELETE FROM public.ledger_gateway_attempt WHERE call_id=c.id;
     DELETE FROM public.ledger_gateway_call WHERE id=c.id;
   ELSE
     UPDATE public.ledger_gateway_call SET phase='released',completed_at=coalesce(completed_at,now()) WHERE id=c.id;
   END IF;
   n:=n+1;
 END LOOP;
 RETURN n;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ledger FROM PUBLIC;
DO $$ BEGIN EXECUTE format('GRANT EXECUTE ON FUNCTION ledger.gateway_context(uuid,uuid,integer,integer),
 ledger.call_claim(uuid,uuid,integer,integer,uuid,text,text,jsonb),
 ledger.call_complete(uuid,uuid,integer,integer,uuid,jsonb,boolean),
 ledger.call_read(uuid,uuid,integer,integer,uuid) TO %I',ledger.gateway_role_name()); END $$;
"""

REVERSE_SQL = r"""
LOCK TABLE ledger_gateway_call,ledger_gateway_attempt,ledger_gateway_idempotency IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.ledger_gateway_call) THEN
   RAISE EXCEPTION 'gateway call rollback refused: retained call history exists';END IF;
END $$;
DROP TRIGGER gateway_attempt_snapshot ON public.ledger_hold;
DROP TRIGGER gateway_expired_call ON public.ledger_ai_usage;
DROP FUNCTION ledger.gateway_attempt_snapshot();
DROP FUNCTION ledger.gateway_expired_call();
DROP FUNCTION ledger.cleanup_gateway_calls(integer);
DROP FUNCTION ledger.call_complete(uuid,uuid,integer,integer,uuid,jsonb,boolean);
DROP FUNCTION ledger.call_claim(uuid,uuid,integer,integer,uuid,text,text,jsonb);
DROP FUNCTION ledger.call_read(uuid,uuid,integer,integer,uuid);
DROP FUNCTION ledger.call_envelope(uuid);
DROP FUNCTION ledger.gateway_metadata_valid(jsonb,boolean);
DROP FUNCTION ledger.gateway_context(uuid,uuid,integer,integer);
DROP FUNCTION ledger.gateway_identity(uuid,uuid,integer,integer);
"""
