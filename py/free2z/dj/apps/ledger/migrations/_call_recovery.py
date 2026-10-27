"""Frozen SQL used only by migration 0005_call_recovery (#2295).

Recovery of an EXISTING gateway call must survive a grant-generation change.

Three predicates, deliberately different, over the same (subject, app,
aep, agen) claims the gateway passes from the bearer token:

* **Admission** of a NEW call or a NEW hold (``call_claim`` inserting,
  ``hold``, ``extend``): ``ledger.gateway_identity`` -- the current account
  epoch AND the current grant generation AND a live (unrevoked) grant.
  Unchanged. A narrowed, rotated or revoked grant never starts new spend.
* **Lookup** of an EXISTING call (``call_read``; ``call_claim`` resolving a
  call by its id or by its idempotency key): ``ledger.call_owner`` -- the
  subject's account at the CURRENT account epoch, the app the call was
  made through, and a credential at least as new as the call's admission
  (``p_agen >= grant_generation`` captured on the call). The grant's
  current generation and ``revoked_at`` are not consulted. A receipt read
  never spends, and a grant that was narrowed (scope reduction), rotated
  (refresh-token reuse) or revoked-then-re-consented -- each moves ``agen``
  (``dj.apps.oidc.consent``) -- must not hide what the app already did and
  was charged for: ``GET /v1/calls/{id}`` is the client's only way out of
  a locally recorded ``settlement_pending``. The generation floor keeps a
  superseded credential inside the work it was itself admitted for: after
  ``bump_generation_for_reuse`` the stolen chain's token still cannot see
  the calls the legitimate device makes under the new generation, even if
  it learns their ids or keys (``revoked``, so the caller re-authenticates).
* **Completion** of an ADMITTED call (``call_complete``): the captured
  admission identity only, exactly as before -- it survives every bump,
  including an account-epoch bump, so an in-flight hold is always settled
  or released. Its only caller is the gateway's settler
  (``rs/crates/f2z-ai/src/meter.rs`` ``finalize``), which holds that
  identity; a current-epoch identity that is not the captured one cannot
  complete a call (least privilege: no consumer needs it).

``call_claim``'s ``context`` is unchanged: it is the caller's standing under
the generation it presented, so a superseded credential recovering its own
call gets ``pending``/``replayed`` with a ``{status: revoked}`` context (the
gateway decodes the context only on ``claimed``;
``docs/free2z/sdk/gateway-interface-public-proposal.md``).

Account-epoch bump (credential compromise, account reset): every lookup
with the old epoch is still refused, receipts included -- every token
minted before the bump is treated as stolen, and a call record carries the
app's own ``metadata`` strings. Money is never moved by these three
functions: ``settle`` and ``release`` act on the hold id and stay
unconditional, and the expiry sweeper releases what nothing settles, so a
bump of either kind can strand nothing.

Signatures are unchanged: the gateway verifies the whole function ABI at
connect (``rs/crates/f2z-ai/src/ledger.rs``), and ``CREATE OR REPLACE``
keeps each function's owner and EXECUTE grants.
"""
SQL = r"""
CREATE FUNCTION ledger.call_owner(p_subject uuid,p_aep integer) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
SELECT a.id FROM public.g12f_creator u JOIN public.ledger_account a ON a.owner_id=u.id AND a.kind='user'
WHERE u.public_id=p_subject AND u.is_active AND u.kt_account_epoch=p_aep $$;

-- Lookup: owner at the current account epoch, same app, a credential at
-- least as new as the call's admission. Not the grant's current state.
CREATE OR REPLACE FUNCTION ledger.call_read(p_subject uuid,p_app uuid,p_aep integer,p_agen integer,p_call uuid)
RETURNS TABLE(status text,record jsonb) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
SELECT ledger.assert_gateway_database();
SELECT CASE WHEN o.account_id IS NULL OR p_app IS NULL OR p_agen IS NULL THEN 'revoked'
            WHEN c.id IS NULL THEN 'not_found'
            WHEN c.grant_generation>p_agen THEN 'revoked' ELSE 'found' END,
 CASE WHEN c.id IS NOT NULL AND c.grant_generation<=p_agen THEN ledger.call_envelope(c.id) END
FROM (SELECT ledger.call_owner(p_subject,p_aep) AS account_id) o
LEFT JOIN public.ledger_gateway_call c ON c.id=p_call AND c.account_id=o.account_id AND c.app_id=p_app
 AND c.created_at>=now()-interval '90 days' $$;

-- Recovery of an existing call by id or key needs the owner, not the grant;
-- only the INSERT of a new call is gated on ledger.gateway_identity.
CREATE OR REPLACE FUNCTION ledger.call_claim(p_subject uuid,p_app uuid,p_aep integer,p_agen integer,
 p_call uuid,p_key text,p_fingerprint text,p_request jsonb)
RETURNS TABLE(status text,call_id uuid,record jsonb,context jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE owner_account bigint;account bigint;existing public.ledger_gateway_call;key_call uuid;
BEGIN
 PERFORM ledger.assert_gateway_database();
 -- Every identity claim is required: recovery below compares against the
 -- call's captured app and generation, and a NULL would compare to nothing.
 IF p_subject IS NULL OR p_app IS NULL OR p_aep IS NULL OR p_agen IS NULL
    OR p_call IS NULL OR substring(p_call::text,15,1)<>'7' OR substring(p_call::text,20,1) NOT IN ('8','9','a','b')
    OR p_fingerprint IS NULL OR p_fingerprint!~'^[0-9a-f]{64}$'
    OR (p_key IS NOT NULL AND (length(p_key) NOT BETWEEN 1 AND 128 OR p_key!~'^[!-~]+$'))
    OR NOT ledger.gateway_metadata_valid(p_request,false) THEN
   RAISE EXCEPTION 'invalid gateway call claim' USING ERRCODE='22023';END IF;
 PERFORM ledger.lock_creator((SELECT id FROM public.g12f_creator WHERE public_id=p_subject));
 owner_account:=ledger.call_owner(p_subject,p_aep);
 context:=ledger.gateway_context(p_subject,p_app,p_aep,p_agen);
 IF owner_account IS NULL THEN status:='revoked';RETURN NEXT;RETURN;END IF;
 SELECT * INTO existing FROM public.ledger_gateway_call c WHERE c.id=p_call;
 IF FOUND AND (existing.account_id<>owner_account OR existing.app_id<>p_app) THEN
   status:='conflict';RETURN NEXT;RETURN;END IF;
 IF existing.id IS NULL AND p_key IS NOT NULL THEN
   SELECT k.call_id INTO key_call FROM public.ledger_gateway_idempotency k
   WHERE k.account_id=owner_account AND k.app_id=p_app AND k.key=p_key AND k.expires_at>now();
   IF FOUND THEN SELECT * INTO existing FROM public.ledger_gateway_call WHERE id=key_call;END IF;
 END IF;
 IF existing.id IS NOT NULL THEN
   -- A superseded credential cannot see work admitted under a later
   -- generation; the caller re-authenticates and recovers with that token.
   IF existing.grant_generation>p_agen THEN status:='revoked';RETURN NEXT;RETURN;END IF;
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
 -- Admission: a new call needs the current, live grant.
 SELECT i.account_id INTO account FROM ledger.gateway_identity(p_subject,p_app,p_aep,p_agen) i;
 IF account IS NULL THEN status:='revoked';RETURN NEXT;RETURN;END IF;
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

-- Completion is authorized ONLY by the CAPTURED admission identity (it
-- survives any bump: the gateway settles with what it admitted under).
-- The only caller is the gateway's settler, which holds that identity; no
-- other consumer exists, so no wider predicate is granted (least privilege).
-- Never a fresh grant or a fresh hold; no money moves here. Unchanged from
-- 0004 except that NULL claims are refused explicitly.
CREATE OR REPLACE FUNCTION ledger.call_complete(p_subject uuid,p_app uuid,p_aep integer,p_agen integer,
 p_call uuid,p_completion jsonb,p_no_hold boolean DEFAULT false)
RETURNS TABLE(status text,record jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.ledger_gateway_call;owner bigint;
BEGIN
 PERFORM ledger.assert_gateway_database();
 IF p_subject IS NULL OR p_app IS NULL OR p_aep IS NULL OR p_agen IS NULL OR p_call IS NULL
    OR NOT ledger.gateway_metadata_valid(p_completion,true) OR p_no_hold IS NULL THEN
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
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ledger FROM PUBLIC;
"""

# The three 0004 bodies, verbatim (``_gateway_calls.py``), so a rewind
# restores the generation-pinned lookups exactly. Metadata-only: no table,
# hold or receipt is touched either way.
REVERSE_SQL = r"""
CREATE OR REPLACE FUNCTION ledger.call_read(p_subject uuid,p_app uuid,p_aep integer,p_agen integer,p_call uuid)
RETURNS TABLE(status text,record jsonb) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
SELECT ledger.assert_gateway_database();
SELECT CASE WHEN i.account_id IS NULL THEN 'revoked' WHEN c.id IS NULL THEN 'not_found' ELSE 'found' END,
 CASE WHEN c.id IS NOT NULL THEN ledger.call_envelope(c.id) END
FROM (SELECT 1) seed LEFT JOIN ledger.gateway_identity(p_subject,p_app,p_aep,p_agen) i ON true
LEFT JOIN public.ledger_gateway_call c ON c.id=p_call AND c.account_id=i.account_id AND c.app_id=p_app
 AND c.created_at>=now()-interval '90 days' $$;

CREATE OR REPLACE FUNCTION ledger.call_claim(p_subject uuid,p_app uuid,p_aep integer,p_agen integer,
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

CREATE OR REPLACE FUNCTION ledger.call_complete(p_subject uuid,p_app uuid,p_aep integer,p_agen integer,
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
DROP FUNCTION ledger.call_owner(uuid,integer);
"""
