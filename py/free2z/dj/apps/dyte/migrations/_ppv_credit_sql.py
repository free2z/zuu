"""Append-only PPV credit receipts; historical cash delivery remains attributable."""
SQL = r"""
CREATE FUNCTION economy.refuse_new_cash_ppv() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.service='livestream_ppv' THEN
  RAISE EXCEPTION 'new_ppv_requires_credit_admission' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER economy_new_ppv_credit_only BEFORE INSERT ON economy_serviceadmission
FOR EACH ROW EXECUTE FUNCTION economy.refuse_new_cash_ppv();

CREATE FUNCTION economy.guard_ppv_credit_admission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE m public.dyte_creatormeeting; who bigint;
BEGIN
 PERFORM economy.policy();
 FOR who IN SELECT id FROM public.g12f_creator WHERE id IN (NEW.host_id,NEW.viewer_id) ORDER BY id LOOP
  PERFORM ledger.lock_creator(who); END LOOP;
 SELECT * INTO m FROM public.dyte_creatormeeting WHERE id=NEW.creator_meeting_id FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM public.g12f_creator WHERE id=NEW.host_id AND is_active)
  OR NOT EXISTS(SELECT 1 FROM public.g12f_creator WHERE id=NEW.viewer_id AND is_active AND kt_account_epoch=NEW.viewer_account_epoch)
  OR m.id IS NULL OR m.creator_id<>NEW.host_id OR m.meeting_id IS DISTINCT FROM NEW.meeting_id
  OR m.provider_session_id IS DISTINCT FROM NEW.provider_session_id
  OR m.provider_session_started_at IS DISTINCT FROM NEW.provider_session_started_at
  OR m.host_session_id IS DISTINCT FROM NEW.host_session_id OR m.host_session_id IS NULL
  OR m.price_per_minute<>NEW.price_per_minute OR NOT m.is_public OR NOT m.live_now
  OR m.lifecycle_state<>'live' OR m.meeting_type<>'ppv'
  OR m.host_session_seen_at IS NULL OR m.host_session_seen_at<statement_timestamp()-interval '60 seconds'
  OR coalesce(m.host_participant_id,'')='' OR m.host_presence_participant_id IS DISTINCT FROM m.host_participant_id
  OR m.host_presence_session_id IS DISTINCT FROM m.provider_session_id
  OR m.host_presence_session_started_at IS DISTINCT FROM m.provider_session_started_at
  OR m.host_peer_id IS NULL OR m.host_joined_at IS NULL OR m.host_left_at IS NOT NULL
  OR m.host_start_claim IS NOT NULL THEN
  RAISE EXCEPTION 'PPV credit admission lacks current authenticated live offer' USING ERRCODE='23514';
 END IF;
 -- The database owns the admission instant. Direct callers cannot backdate it.
 NEW.admitted_at:=statement_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER dyte_ppv_credit_admission_guard BEFORE INSERT ON dyte_ppvcreditadmission
FOR EACH ROW EXECUTE FUNCTION economy.guard_ppv_credit_admission();
CREATE TRIGGER dyte_ppv_credit_admission_immutable BEFORE UPDATE OR DELETE ON dyte_ppvcreditadmission
FOR EACH ROW EXECUTE FUNCTION economy.immutable_record();
CREATE TRIGGER dyte_ppv_credit_delivery_immutable BEFORE UPDATE OR DELETE ON dyte_ppvcreditdelivery
FOR EACH ROW EXECUTE FUNCTION economy.immutable_record();

-- Both dispatchers already take this cohort lock before finance locks. The
-- insert guard additionally covers direct inserts and either arrival order.
-- Refusal rolls back the entire old or new settlement, including its claim.
CREATE FUNCTION economy.guard_ppv_cross_delivery() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='economy_servicedelivery' THEN
  IF NEW.service<>'livestream_ppv' THEN RETURN NEW; END IF;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('ppv:'||NEW.cohort,0));
 IF TG_TABLE_NAME='economy_servicedelivery' THEN
  IF EXISTS(SELECT 1 FROM public.dyte_ppvcreditdelivery WHERE cohort=NEW.cohort AND interval && NEW.interval) THEN
   RAISE EXCEPTION 'PPV delivery overlaps previously settled credit service' USING ERRCODE='23514'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM public.economy_servicedelivery WHERE service='livestream_ppv'
   AND cohort=NEW.cohort AND interval && NEW.interval) THEN
   RAISE EXCEPTION 'PPV credit delivery overlaps previously settled cash service' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER economy_ppv_cross_delivery BEFORE INSERT ON economy_servicedelivery
FOR EACH ROW EXECUTE FUNCTION economy.guard_ppv_cross_delivery();
CREATE TRIGGER dyte_ppv_cross_delivery BEFORE INSERT ON dyte_ppvcreditdelivery
FOR EACH ROW EXECUTE FUNCTION economy.guard_ppv_cross_delivery();

CREATE FUNCTION economy.guard_ppv_credit_delivery() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a public.dyte_ppvcreditadmission; b public.dyte_providerparticipantbinding;
 e jsonb; minutes bigint; requested bigint; actual bigint;
BEGIN
 PERFORM economy.policy();
 e:=NEW.evidence;
 SELECT * INTO STRICT a FROM public.dyte_ppvcreditadmission WHERE id=NEW.admission_id;
 SELECT * INTO b FROM public.dyte_providerparticipantbinding WHERE id=(e->>'binding_id')::bigint;
 IF b.id IS NULL OR b.app_id<>a.app_id OR b.meeting_id<>a.meeting_id
  OR b.creator_id<>a.host_id OR b.actor_id IS DISTINCT FROM a.viewer_id OR b.role<>'viewer'
  OR b.participant_id IS DISTINCT FROM e->>'canonical_participant_id'
  OR b.custom_participant_id<>'pc_'||replace(a.id::text,'-','')
  OR e->>'participant_id' IS DISTINCT FROM b.custom_participant_id
  OR e->>'meeting_id' IS DISTINCT FROM a.meeting_id
  OR e->>'provider_session_id' IS DISTINCT FROM a.provider_session_id::text
  OR e->>'provider_session_started_at' IS NULL
  OR (e->>'provider_session_started_at')::timestamptz<>a.provider_session_started_at
  OR NOT EXISTS(SELECT 1 FROM public.dyte_webhookdelivery w
   WHERE w.provider_event_id::text=e->>'provider_event_id' AND w.business_event_key=NEW.provider_key
    AND w.event_type='meeting.participantLeft' AND w.payload_sha256=e->>'payload_sha256')
  OR NEW.cohort<>a.provider_session_id::text||':'||a.viewer_id::text
  OR isempty(NEW.interval) OR lower_inf(NEW.interval) OR upper_inf(NEW.interval)
  OR NOT lower_inc(NEW.interval) OR upper_inc(NEW.interval)
  OR lower(NEW.interval)<a.admitted_at OR upper(NEW.interval)>statement_timestamp()
  OR lower(NEW.interval) IS DISTINCT FROM (e->>'joined_at')::timestamptz
  OR upper(NEW.interval) IS DISTINCT FROM (e->>'left_at')::timestamptz THEN
  RAISE EXCEPTION 'PPV credit delivery lacks original bound provider evidence' USING ERRCODE='23514';
 END IF;
 minutes:=ceil(extract(epoch FROM upper(NEW.interval)-lower(NEW.interval))/60);
 requested:=ceil(a.price_per_minute*minutes)*1000;
 IF NEW.platform_collected_m2z>(minutes/2)*1000 OR NEW.creator_collected_m2z>requested THEN
  RAISE EXCEPTION 'PPV credit collection exceeds original offer' USING ERRCODE='23514'; END IF;
 SELECT coalesce(sum(t.amount),0) INTO actual FROM public.ledger_transfer t
  JOIN public.ledger_account src ON src.id=t.debit_account_id
  JOIN public.ledger_account dst ON dst.id=t.credit_account_id
  WHERE t.id::text=e->>'platform_transfer_id' AND t.code='spend_up_to' AND t.ref_kind='ppv_credit_platform'
   AND t.ref_id=NEW.provider_key AND src.owner_id=a.viewer_id AND src.kind='user' AND dst.key='sys:platform_revenue';
 IF actual<>NEW.platform_collected_m2z THEN RAISE EXCEPTION 'PPV platform credit collection mismatch'; END IF;
 SELECT coalesce(sum(t.amount),0) INTO actual FROM public.ledger_transfer t
  JOIN public.ledger_account src ON src.id=t.debit_account_id
  JOIN public.ledger_account dst ON dst.id=t.credit_account_id
  WHERE t.id::text=e->>'collection_transfer_id' AND t.code='spend_up_to' AND t.ref_kind='ppv_credit_service'
   AND t.ref_id=NEW.provider_key AND src.owner_id=a.viewer_id AND src.kind='user' AND dst.key='sys:platform_revenue';
 IF actual<>NEW.creator_collected_m2z THEN RAISE EXCEPTION 'PPV creator credit collection mismatch'; END IF;
 SELECT coalesce(sum(t.amount),0) INTO actual FROM public.ledger_transfer t
  JOIN public.ledger_account src ON src.id=t.debit_account_id
  JOIN public.ledger_account dst ON dst.id=t.credit_account_id
  WHERE t.id::text=e->>'credit_transfer_id' AND t.code='transfer' AND t.ref_kind='ppv_credit'
   AND t.ref_id=NEW.provider_key AND src.key='sys:platform_revenue' AND dst.owner_id=a.host_id AND dst.kind='user';
 IF actual<>NEW.creator_credited_m2z THEN RAISE EXCEPTION 'PPV creator credit mismatch'; END IF;
 SELECT coalesce(sum(t.amount),0) INTO actual FROM public.ledger_transfer t
  JOIN public.ledger_account src ON src.id=t.debit_account_id
  JOIN public.ledger_account dst ON dst.id=t.credit_account_id
  WHERE t.id::text=e->>'repay_transfer_id' AND t.code='debt_repay' AND t.meta->>'origin'='transfer'
   AND t.ref_kind='ppv_credit' AND t.ref_id=NEW.provider_key
   AND src.key='sys:platform_revenue' AND dst.owner_id=a.host_id AND dst.kind='user_debt';
 IF actual<>NEW.creator_debt_repaid_m2z THEN RAISE EXCEPTION 'PPV creator debt repayment mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER dyte_ppv_credit_delivery_guard BEFORE INSERT ON dyte_ppvcreditdelivery
FOR EACH ROW EXECUTE FUNCTION economy.guard_ppv_credit_delivery();

CREATE FUNCTION economy.settle_ppv_credit_delivery(p_admission uuid,p_key text,p_evidence jsonb)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a public.dyte_ppvcreditadmission; d public.dyte_ppvcreditdelivery;
 joined timestamptz; departed timestamptz; minutes bigint; requested bigint; who bigint;
 group_key text; platform record; collected record; credited record; child uuid; basis jsonb;
BEGIN
 PERFORM economy.policy();
 SELECT * INTO STRICT a FROM public.dyte_ppvcreditadmission WHERE id=p_admission;
 joined:=(p_evidence->>'joined_at')::timestamptz; departed:=(p_evidence->>'left_at')::timestamptz;
 IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 240 OR joined IS NULL OR departed IS NULL
  OR joined<a.admitted_at OR departed<=joined OR departed>statement_timestamp() THEN
  RAISE EXCEPTION 'invalid original PPV credit interval'; END IF;
 group_key:=a.provider_session_id::text||':'||a.viewer_id::text;
 PERFORM pg_advisory_xact_lock(hashtextextended('ppv:'||group_key,0));
 SELECT * INTO d FROM public.dyte_ppvcreditdelivery WHERE provider_key=p_key;
 IF FOUND THEN
  IF d.admission_id<>a.id OR d.interval<>tstzrange(joined,departed,'[)')
   OR d.evidence-'platform_transfer_id'-'collection_transfer_id'-'credit_transfer_id'-'repay_transfer_id'
      -'duration_minutes'-'requested_creator_m2z' IS DISTINCT FROM p_evidence THEN
   RAISE EXCEPTION 'PPV credit delivery replay identity changed'; END IF;
  RETURN d.id;
 END IF;
 IF EXISTS(SELECT 1 FROM public.dyte_ppvcreditdelivery WHERE cohort=group_key AND interval && tstzrange(joined,departed,'[)'))
  OR EXISTS(SELECT 1 FROM public.economy_servicedelivery WHERE service='livestream_ppv'
   AND cohort=group_key AND interval && tstzrange(joined,departed,'[)')) THEN
  RAISE EXCEPTION 'PPV credit delivery overlaps previously settled service'; END IF;
 FOR who IN SELECT id FROM public.g12f_creator WHERE id IN (a.viewer_id,a.host_id) ORDER BY id LOOP
  PERFORM ledger.lock_creator(who); END LOOP;
 minutes:=ceil(extract(epoch FROM departed-joined)/60);
 requested:=ceil(a.price_per_minute*minutes)*1000;
 SELECT * INTO platform FROM ledger.spend_up_to(a.viewer_id,(minutes/2)*1000,'ppv_credit_platform',p_key);
 SELECT * INTO collected FROM ledger.spend_up_to(a.viewer_id,requested,'ppv_credit_service',p_key);
 IF collected.charged>0 THEN
  SELECT * INTO credited FROM ledger.credit_user(a.host_id,collected.charged,'sys:platform_revenue',
   'transfer','ppv_credit',p_key,'ppv-credit:'||p_key);
  IF credited.status<>'posted' THEN RAISE EXCEPTION 'PPV credit lacks original settlement'; END IF;
 ELSE
  SELECT 0::bigint AS credited,0::bigint AS debt_repaid,NULL::bigint AS transfer_id,NULL::bigint AS repay_transfer_id INTO credited;
 END IF;
 child:=ledger.uuid_v7();
 basis:=p_evidence||jsonb_build_object('platform_transfer_id',platform.transfer_id,
  'collection_transfer_id',collected.transfer_id,'credit_transfer_id',credited.transfer_id,
  'repay_transfer_id',credited.repay_transfer_id,'duration_minutes',minutes,'requested_creator_m2z',requested);
 INSERT INTO public.dyte_ppvcreditdelivery(id,admission_id,provider_key,cohort,interval,
  platform_collected_m2z,creator_collected_m2z,creator_credited_m2z,creator_debt_repaid_m2z,evidence,created_at)
 VALUES(child,a.id,p_key,group_key,tstzrange(joined,departed,'[)'),platform.charged,collected.charged,
  credited.credited,credited.debt_repaid,basis,statement_timestamp());
 RETURN child;
END $$;
REVOKE ALL ON FUNCTION economy.refuse_new_cash_ppv(), economy.guard_ppv_credit_admission(),
 economy.guard_ppv_cross_delivery(), economy.guard_ppv_credit_delivery(),
 economy.settle_ppv_credit_delivery(uuid,text,jsonb) FROM PUBLIC;
"""

# Financial receipts and the prospective boundary survive an application rollback.
REVERSE = r"""
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.economy_economicpolicy WHERE version<>0)
  OR EXISTS(SELECT 1 FROM public.dyte_ppvcreditadmission)
  OR EXISTS(SELECT 1 FROM public.economy_serviceadmission) THEN
  RAISE EXCEPTION 'PPV policy or admission history prevents reversal';
 END IF;
END $$;
DROP TRIGGER dyte_ppv_credit_delivery_guard ON dyte_ppvcreditdelivery;
DROP TRIGGER dyte_ppv_cross_delivery ON dyte_ppvcreditdelivery;
DROP TRIGGER economy_ppv_cross_delivery ON economy_servicedelivery;
DROP TRIGGER dyte_ppv_credit_delivery_immutable ON dyte_ppvcreditdelivery;
DROP TRIGGER dyte_ppv_credit_admission_immutable ON dyte_ppvcreditadmission;
DROP TRIGGER dyte_ppv_credit_admission_guard ON dyte_ppvcreditadmission;
DROP TRIGGER economy_new_ppv_credit_only ON economy_serviceadmission;
DROP FUNCTION economy.settle_ppv_credit_delivery(uuid,text,jsonb), economy.guard_ppv_credit_delivery(),
 economy.guard_ppv_cross_delivery(), economy.guard_ppv_credit_admission(), economy.refuse_new_cash_ppv();
"""
