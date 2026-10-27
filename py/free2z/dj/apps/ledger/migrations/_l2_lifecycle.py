"""Frozen SQL used only by migration 0003_holds. Change via a later migration."""
SQL = r"""
CREATE FUNCTION ledger.gateway_role_name() RETURNS name
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
    SELECT ('ai_gateway_' || substr(encode(sha256(convert_to(current_database(),'UTF8')),'hex'),1,48))::name
$$;
CREATE FUNCTION ledger.assert_gateway_database() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
    -- A gateway LOGIN cannot become the trusted function owner. session_user
    -- survives SET ROLE and copied ACLs after database restore.
    IF session_user=current_user THEN RETURN; END IF;
    IF NOT coalesce(pg_has_role(session_user,to_regrole(ledger.gateway_role_name()::text),'MEMBER'),false) THEN
        RAISE EXCEPTION 'ledger gateway credential belongs to a different database' USING ERRCODE='42501';
    END IF;
END $$;


CREATE FUNCTION ledger.cap_remaining(p_app uuid, p_account bigint, p_at timestamptz)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT CASE WHEN c.cap_m2z IS NULL THEN NULL ELSE
    greatest(c.cap_m2z - coalesce(w.spent_m2z,0) - coalesce(w.held_m2z,0),0) END
    FROM public.ledger_spend_cap c LEFT JOIN public.ledger_spend_window w
    ON w.app_id=c.app_id AND w.account_id=c.account_id
    AND w.window_start=ledger.window_start(c.period,p_at)
    WHERE c.app_id=p_app AND c.account_id=p_account $$;

-- Internal: the caller owns creator, account, then hold locks. The consumed
-- row is the unique terminal transition; callers losing that race re-read it.
CREATE FUNCTION ledger.finish_hold(p_hold uuid, p_outcome text, p_priced bigint,
    p_charge bigint, p_provider bigint, p_developer bigint, p_cost bigint,
    p_ws timestamptz, p_usage jsonb)
RETURNS public.ledger_ai_usage LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE h public.ledger_hold; a public.ledger_account; u public.ledger_ai_usage;
    debt_id bigint; repay bigint; posted record; receipt bigint;
BEGIN
    DELETE FROM public.ledger_hold WHERE id=p_hold RETURNING * INTO h;
    IF NOT FOUND THEN RETURN NULL; END IF;
    PERFORM ledger.heal_balance(h.account_id,(SELECT c.tuzis FROM public.g12f_creator c
        JOIN public.ledger_account acct ON acct.owner_id=c.id WHERE acct.id=h.account_id));
    UPDATE public.ledger_account SET held=held-h.amount, updated_at=now()
        WHERE id=h.account_id RETURNING * INTO a;
    SELECT d.id, greatest(least(-d.balance, a.balance-a.held-p_charge),0)
        INTO debt_id,repay FROM public.ledger_account d
        WHERE d.key='user_debt:'||a.owner_id AND d.balance<0 FOR NO KEY UPDATE;
    IF coalesce(repay,0)>0 THEN
        SELECT * INTO posted FROM ledger.post_transfer(a.id,debt_id,repay,'debt_repay','hold',h.id::text,NULL,NULL);
        IF posted.status <> 'posted' THEN RAISE EXCEPTION 'hold repayment refused: %',posted.status; END IF;
    END IF;
    IF p_charge>0 THEN
        SELECT * INTO posted FROM ledger.post_transfer(a.id,ledger.sys('sys:ai_clearing'),p_charge,'ai_settle','hold',h.id::text,NULL,NULL);
        IF posted.status <> 'posted' THEN RAISE EXCEPTION 'hold settlement refused: %',posted.status; END IF;
        receipt := posted.transfer_id;
    END IF;
    IF h.window_start IS NOT NULL THEN
        UPDATE public.ledger_spend_window SET held_m2z=held_m2z-h.amount
            WHERE app_id=h.app_id AND account_id=h.account_id AND window_start=h.window_start;
        IF NOT FOUND THEN RAISE EXCEPTION 'hold window missing'; END IF;
    END IF;
    IF p_ws IS NOT NULL THEN
        INSERT INTO public.ledger_spend_window(app_id,account_id,window_start,spent_m2z)
            VALUES(h.app_id,h.account_id,p_ws,p_charge)
            ON CONFLICT(app_id,account_id,window_start) DO UPDATE
            SET spent_m2z=ledger_spend_window.spent_m2z+EXCLUDED.spent_m2z;
    END IF;
    INSERT INTO public.ledger_ai_usage(hold_id,hold_created_at,account_id,app_id,idem,window_start,
        outcome,hold_amount,priced,charged,shortfall,logical_key,provider_m2z,developer_m2z,
        platform_m2z,cost_nusd,rate_card_id,model_id,min_charge_2z,attempt,dev_markup_bps,transfer_id,usage,
        late_settle_attempted)
    VALUES(h.id,h.created_at,h.account_id,h.app_id,h.idem,p_ws,p_outcome,h.amount,p_priced,p_charge,
        p_priced-p_charge,h.logical_key,p_provider,p_developer,p_charge-p_provider-p_developer,p_cost,
        h.rate_card_id,h.model_id,h.min_charge_2z,h.attempt,h.dev_markup_bps,receipt,coalesce(p_usage,'{}'),
        p_outcome<>'settled' AND p_provider>0) RETURNING * INTO u;
    IF p_provider<>0 OR p_developer<>0 OR u.platform_m2z<>0 THEN
        INSERT INTO public.ledger_ai_split_queue(usage_id,developer_creator_id,provider_m2z,developer_m2z,platform_m2z)
        VALUES(u.id,(SELECT developer_creator_id FROM public.ledger_app WHERE id=h.app_id),
               p_provider,p_developer,u.platform_m2z);
    END IF;
    RETURN u;
END $$;

CREATE FUNCTION ledger.inquire(p_subject uuid,p_app_id uuid)
RETURNS TABLE(available bigint,cap_remaining bigint,debt bigint,open_holds integer,frozen boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
SELECT ledger.assert_gateway_database();
WITH current AS (
    SELECT c.id AS owner, a.id AS account, a.balance, coalesce(a.held,0) AS held,
           coalesce(a.frozen,false) AS frozen, ledger.debt(c.id) AS debt,
           CASE WHEN a.id IS NULL OR coalesce(cfg.dual_write AND cfg.heal_enabled,false)
                THEN (c.tuzis*1000)::bigint ELSE a.balance END AS target
    FROM public.g12f_creator c LEFT JOIN public.ledger_account a ON a.owner_id=c.id AND a.kind='user'
    LEFT JOIN public.ledger_config cfg ON cfg.id WHERE c.public_id=p_subject
), projected AS (
    SELECT *,CASE WHEN account IS NOT NULL AND target>balance
                  THEN greatest(least(debt,target-balance,target-held),0) ELSE 0 END AS repay FROM current
)
SELECT CASE WHEN debt-repay>0 THEN 0 ELSE greatest(target-repay-held,0) END,
       ledger.cap_remaining(p_app_id,account,now()),debt-repay,
       (SELECT count(*)::integer FROM public.ledger_hold h WHERE h.account_id=account),frozen
FROM projected $$;

CREATE FUNCTION ledger.hold_internal(p_subject uuid,p_app_id uuid,p_amount bigint,p_hold_key text,p_logical_key text,
    p_attempt integer DEFAULT 0,p_ttl_s integer DEFAULT 300,p_account_epoch integer DEFAULT NULL,
    p_grant_generation integer DEFAULT NULL,p_model_id text DEFAULT NULL,p_rate_card_version bigint DEFAULT NULL,
    p_catalog_version text DEFAULT NULL,p_markup_bps integer DEFAULT 0,p_meta jsonb DEFAULT '{}')
RETURNS TABLE(hold_id uuid,status text,state text,available bigint,cap_remaining bigint,
              expires_at timestamptz,amount bigint,applied_markup_bps integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE cr public.g12f_creator; app public.ledger_app; a public.ledger_account;
    cap public.ledger_spend_cap; h public.ledger_hold; u public.ledger_ai_usage;
    w public.ledger_spend_window; card bigint; minimum integer; ws timestamptz;
    markup integer; account bigint;
BEGIN
    IF p_amount IS NULL OR p_amount<=0 OR p_hold_key IS NULL OR p_hold_key='' OR p_logical_key IS NULL
       OR p_logical_key='' OR p_markup_bps IS NULL OR p_markup_bps NOT BETWEEN 0 AND 10000 THEN
        RAISE EXCEPTION 'ledger.hold: invalid arguments' USING ERRCODE='22023';
    END IF;
    status:='invalid'; amount:=0;
    SELECT * INTO cr FROM public.g12f_creator WHERE public_id=p_subject FOR NO KEY UPDATE;
    IF NOT FOUND OR NOT cr.is_active THEN RETURN NEXT; RETURN; END IF;
    IF p_account_epoch IS NOT NULL AND cr.kt_account_epoch<>p_account_epoch THEN status:='revoked'; RETURN NEXT; RETURN; END IF;
    SELECT * INTO app FROM public.ledger_app WHERE id=p_app_id;
    IF NOT FOUND THEN RETURN NEXT; RETURN; END IF;
    IF app.frozen THEN status:='frozen'; RETURN NEXT; RETURN; END IF;
    IF p_rate_card_version IS NOT NULL THEN
        SELECT r.id,m.min_charge_2z INTO card,minimum FROM public.pricing_ratecard r
        JOIN public.pricing_ratecard_model m ON m.rate_card_id=r.id
        WHERE r.version=p_rate_card_version AND r.active AND r.published_at IS NOT NULL AND m.model_id=p_model_id;
        IF NOT FOUND THEN status:='unknown_rate_card'; RETURN NEXT; RETURN; END IF;
    END IF;
    account:=ledger.ensure_account(cr.id);
    SELECT * INTO a FROM public.ledger_account WHERE id=account FOR NO KEY UPDATE;
    a:=ledger.heal_balance(a.id,cr.tuzis);
    FOR h IN SELECT * FROM public.ledger_hold x WHERE x.account_id=a.id AND x.expires_at<now() LOOP
        PERFORM ledger.finish_hold(h.id,'expired',0,0,0,0,0,h.window_start,'{}');
    END LOOP;
    SELECT * INTO a FROM public.ledger_account WHERE id=a.id;
    available:=greatest(a.balance-a.held,0);
    cap_remaining:=ledger.cap_remaining(p_app_id,a.id,now());
    IF a.frozen THEN status:='frozen'; RETURN NEXT; RETURN; END IF;
    SELECT * INTO cap FROM public.ledger_spend_cap WHERE app_id=p_app_id AND account_id=a.id;
    IF (FOUND AND (cap.revoked_at IS NOT NULL OR (p_grant_generation IS NOT NULL AND cap.grant_generation<>p_grant_generation)))
       OR (NOT FOUND AND p_app_id<>'00000000-0000-4000-8000-000000000001'::uuid) THEN
        status:='revoked'; RETURN NEXT; RETURN;
    END IF;
    IF coalesce(cap.markup_bps,0)<>p_markup_bps THEN status:='markup_mismatch'; RETURN NEXT; RETURN; END IF;
    IF ledger.debt(cr.id)>0 THEN status:='in_debt'; available:=0; RETURN NEXT; RETURN; END IF;
    markup:=least(p_markup_bps,app.markup_bps,coalesce(app.approved_markup_bps,0));
    SELECT * INTO h FROM public.ledger_hold x WHERE x.app_id=p_app_id AND x.account_id=a.id AND x.idem=p_hold_key;
    IF FOUND THEN
        hold_id:=h.id; status:='replayed';state:='open';expires_at:=h.expires_at;amount:=h.amount;applied_markup_bps:=h.dev_markup_bps;
        RETURN NEXT;RETURN;
    END IF;
    SELECT * INTO u FROM public.ledger_ai_usage x WHERE x.app_id=p_app_id AND x.account_id=a.id
        AND x.created_at>=now()-interval '24 hours' AND (x.idem=p_hold_key OR (x.logical_key=p_logical_key AND x.outcome='settled'))
        ORDER BY (x.idem=p_hold_key) DESC LIMIT 1;
    IF FOUND THEN
        hold_id:=u.hold_id;status:='replayed';state:=u.outcome;applied_markup_bps:=u.dev_markup_bps;RETURN NEXT;RETURN;
    END IF;
    IF (SELECT count(*) FROM public.ledger_hold x WHERE x.account_id=a.id)>=16 THEN status:='too_many_holds';RETURN NEXT;RETURN;END IF;
    IF cap.cap_m2z IS NOT NULL THEN
        ws:=ledger.window_start(cap.period,now());
        INSERT INTO public.ledger_spend_window(app_id,account_id,window_start) VALUES(p_app_id,a.id,ws)
            ON CONFLICT(app_id,account_id,window_start) DO UPDATE SET held_m2z=ledger_spend_window.held_m2z RETURNING * INTO w;
        IF w.spent_m2z+w.held_m2z+p_amount>cap.cap_m2z THEN status:='cap_exceeded';RETURN NEXT;RETURN;END IF;
    END IF;
    UPDATE public.ledger_account SET held=held+p_amount,updated_at=now() WHERE id=a.id AND balance-held>=p_amount AND NOT frozen;
    IF NOT FOUND THEN status:='insufficient_balance';RETURN NEXT;RETURN;END IF;
    IF ws IS NOT NULL THEN UPDATE public.ledger_spend_window SET held_m2z=held_m2z+p_amount
        WHERE app_id=p_app_id AND account_id=a.id AND window_start=ws; END IF;
    INSERT INTO public.ledger_hold(id,account_id,app_id,idem,logical_key,attempt,amount,dev_markup_bps,
        rate_card_id,model_id,min_charge_2z,catalog_version,cap_window_revision,window_start,expires_at,meta)
    VALUES(ledger.uuid_v7(),a.id,p_app_id,p_hold_key,p_logical_key,coalesce(p_attempt,0),p_amount,markup,
        card,p_model_id,minimum,p_catalog_version,coalesce(cap.cap_window_revision,0),ws,now()+greatest(5,least(coalesce(p_ttl_s,300),3600))*interval '1 second',coalesce(p_meta,'{}'))
    RETURNING * INTO h;
    hold_id:=h.id; status:='held';state:='open'; available:=available-p_amount;
    cap_remaining:=ledger.cap_remaining(p_app_id,a.id,now());expires_at:=h.expires_at;amount:=h.amount;applied_markup_bps:=markup;
    RETURN NEXT;
END $$;
"""

SQL += r"""
CREATE FUNCTION ledger.release(p_hold_id uuid,p_usage jsonb DEFAULT '{}')
RETURNS TABLE(status text,state text,available bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE h public.ledger_hold; a public.ledger_account; u public.ledger_ai_usage;
BEGIN
    PERFORM ledger.assert_gateway_database();
    SELECT * INTO h FROM public.ledger_hold WHERE id=p_hold_id;
    IF FOUND THEN
        PERFORM ledger.lock_creator((SELECT owner_id FROM public.ledger_account WHERE id=h.account_id));
        SELECT * INTO a FROM public.ledger_account WHERE id=h.account_id FOR NO KEY UPDATE;
        SELECT * INTO h FROM public.ledger_hold WHERE id=p_hold_id;
        IF FOUND THEN
            u:=ledger.finish_hold(h.id,CASE WHEN h.expires_at<now() THEN 'expired' ELSE 'released' END,
                                  0,0,0,0,0,h.window_start,p_usage);
            status:=u.outcome;state:=u.outcome;
            SELECT greatest(balance-held,0) INTO available FROM public.ledger_account WHERE id=a.id;
            IF ledger.debt(a.owner_id)>0 THEN available:=0; END IF;
            RETURN NEXT;RETURN;
        END IF;
    END IF;
    SELECT * INTO u FROM public.ledger_ai_usage WHERE hold_id=p_hold_id
        AND created_at>=ledger.uuid_v7_time(p_hold_id)-interval '1 hour' LIMIT 1;
    status:=coalesce(u.outcome,'invalid');state:=u.outcome;RETURN NEXT;
END $$;

CREATE FUNCTION ledger.expired_hold_ids(p_limit integer DEFAULT 100) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
SELECT id FROM public.ledger_hold WHERE expires_at<now() ORDER BY expires_at LIMIT greatest(0,least(p_limit,1000)) $$;

CREATE FUNCTION ledger.expire_hold(p_hold_id uuid)
RETURNS TABLE(status text,released_m2z bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE h public.ledger_hold;
BEGIN
    status:='not_found';released_m2z:=0;
    SELECT * INTO h FROM public.ledger_hold WHERE id=p_hold_id;
    IF NOT FOUND THEN RETURN NEXT;RETURN;END IF;
    PERFORM ledger.lock_creator((SELECT owner_id FROM public.ledger_account WHERE id=h.account_id));
    PERFORM 1 FROM public.ledger_account WHERE id=h.account_id FOR NO KEY UPDATE;
    SELECT * INTO h FROM public.ledger_hold WHERE id=p_hold_id;
    IF NOT FOUND THEN RETURN NEXT;RETURN;END IF;
    IF h.expires_at>=now() THEN status:='not_expired';RETURN NEXT;RETURN;END IF;
    PERFORM ledger.finish_hold(h.id,'expired',0,0,0,0,0,h.window_start,'{}');
    status:='expired';released_m2z:=h.amount;RETURN NEXT;
END $$;

CREATE FUNCTION ledger.extend_internal(p_hold_id uuid,p_amount_to bigint DEFAULT NULL,p_ttl_s integer DEFAULT 300,
    p_account_epoch integer DEFAULT NULL,p_grant_generation integer DEFAULT NULL)
RETURNS TABLE(status text,state text,amount bigint,expires_at timestamptz,available bigint,cap_remaining bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE h public.ledger_hold; a public.ledger_account; cr public.g12f_creator; app public.ledger_app;
    cap public.ledger_spend_cap; u public.ledger_ai_usage; w public.ledger_spend_window;
    delta bigint;ws timestamptz;room bigint;
BEGIN
    status:='invalid';
    SELECT * INTO h FROM public.ledger_hold WHERE id=p_hold_id;
    IF FOUND THEN
        SELECT * INTO cr FROM public.g12f_creator WHERE id=(SELECT owner_id FROM public.ledger_account WHERE id=h.account_id) FOR NO KEY UPDATE;
        SELECT * INTO a FROM public.ledger_account WHERE id=h.account_id FOR NO KEY UPDATE;
        SELECT * INTO h FROM public.ledger_hold WHERE id=p_hold_id;
    END IF;
    IF h.id IS NULL THEN
        SELECT * INTO u FROM public.ledger_ai_usage WHERE hold_id=p_hold_id
            AND created_at>=ledger.uuid_v7_time(p_hold_id)-interval '1 hour' LIMIT 1;
        IF FOUND THEN status:='not_open';state:=u.outcome;END IF;
        RETURN NEXT;RETURN;
    END IF;
    a:=ledger.heal_balance(a.id,cr.tuzis);
    amount:=h.amount;expires_at:=h.expires_at;available:=greatest(a.balance-a.held,0);
    cap_remaining:=ledger.cap_remaining(h.app_id,a.id,now());state:='open';
    IF h.expires_at<now() THEN
        PERFORM ledger.finish_hold(h.id,'expired',0,0,0,0,0,h.window_start,'{}');
        status:='not_open';state:='expired';amount:=0;expires_at:=NULL;
        SELECT greatest(balance-held,0) INTO available FROM public.ledger_account WHERE id=a.id;
        cap_remaining:=ledger.cap_remaining(h.app_id,a.id,now());RETURN NEXT;RETURN;
    END IF;
    SELECT * INTO app FROM public.ledger_app WHERE id=h.app_id;
    SELECT * INTO cap FROM public.ledger_spend_cap WHERE app_id=h.app_id AND account_id=a.id;
    IF NOT cr.is_active OR (p_account_epoch IS NOT NULL AND cr.kt_account_epoch<>p_account_epoch)
       OR app.id IS NULL OR cap.revoked_at IS NOT NULL
       OR (cap.app_id IS NULL AND h.app_id<>'00000000-0000-4000-8000-000000000001'::uuid)
       OR (p_grant_generation IS NOT NULL AND cap.grant_generation IS DISTINCT FROM p_grant_generation) THEN
        status:='revoked';RETURN NEXT;RETURN;END IF;
    IF app.frozen OR a.frozen THEN status:='frozen';RETURN NEXT;RETURN;END IF;
    IF ledger.debt(cr.id)>0 THEN status:='insufficient_balance';available:=0;RETURN NEXT;RETURN;END IF;
    UPDATE public.ledger_hold x SET expires_at=least(h.created_at+interval '24 hours',now()+greatest(5,least(coalesce(p_ttl_s,300),3600))*interval '1 second')
        WHERE x.id=h.id RETURNING x.expires_at INTO expires_at;
    delta:=greatest(coalesce(p_amount_to,h.amount)-h.amount,0);
    status:='held';
    IF delta=0 THEN RETURN NEXT;RETURN;END IF;
    IF cap.cap_m2z IS NOT NULL THEN
        ws:=CASE WHEN h.window_start IS NOT NULL AND h.cap_window_revision=cap.cap_window_revision
                 THEN h.window_start ELSE ledger.window_start(cap.period,now()) END;
        INSERT INTO public.ledger_spend_window(app_id,account_id,window_start) VALUES(h.app_id,a.id,ws)
            ON CONFLICT(app_id,account_id,window_start) DO UPDATE SET held_m2z=ledger_spend_window.held_m2z RETURNING * INTO w;
        room:=greatest(cap.cap_m2z-w.spent_m2z-w.held_m2z,0);
        -- An uncapped-origin hold's existing amount was never in this
        -- window. Its full raised target must fit the new window's room.
        IF (CASE WHEN h.window_start IS DISTINCT FROM ws THEN h.amount+delta ELSE delta END)>room THEN
            status:='cap_exceeded';cap_remaining:=room;RETURN NEXT;RETURN;END IF;
    END IF;
    IF delta>available THEN status:='insufficient_balance';RETURN NEXT;RETURN;END IF;
    UPDATE public.ledger_account SET held=held+delta,updated_at=now() WHERE id=a.id;
    IF ws IS NOT NULL AND h.window_start IS DISTINCT FROM ws THEN
        -- The user's accounting frame changed. Move the whole reservation
        -- only after the current frame has room for the new target; the
        -- previously reserved portion remains grandfathered on refusal.
        IF h.window_start IS NOT NULL THEN
            UPDATE public.ledger_spend_window SET held_m2z=held_m2z-h.amount
                WHERE app_id=h.app_id AND account_id=a.id AND window_start=h.window_start;
        END IF;
        UPDATE public.ledger_spend_window SET held_m2z=held_m2z+h.amount+delta
            WHERE app_id=h.app_id AND account_id=a.id AND window_start=ws;
    ELSIF h.window_start IS NOT NULL THEN
        UPDATE public.ledger_spend_window SET held_m2z=held_m2z+delta
            WHERE app_id=h.app_id AND account_id=a.id AND window_start=h.window_start;
    END IF;
    UPDATE public.ledger_hold SET amount=h.amount+delta,window_start=coalesce(ws,h.window_start),
        cap_window_revision=CASE WHEN ws IS NOT NULL THEN cap.cap_window_revision ELSE h.cap_window_revision END
        WHERE id=h.id;
    amount:=h.amount+delta;available:=available-delta;cap_remaining:=ledger.cap_remaining(h.app_id,a.id,now());RETURN NEXT;
END $$;
"""

SQL += r"""
CREATE FUNCTION ledger.settle_internal(p_hold_id uuid,p_value bigint,p_fixed boolean,p_usage jsonb)
RETURNS TABLE(status text,state text,priced bigint,charged bigint,shortfall bigint,
              transfer_id bigint,available bigint,cap_remaining bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE h public.ledger_hold;a public.ledger_account;u public.ledger_ai_usage;
    cap public.ledger_spend_cap;w public.ledger_spend_window;cost bigint;provider bigint;
    dev bigint;terms record;ws timestamptz;room bigint;ceiling numeric;charge bigint;
    terminal_reason text;
BEGIN
    IF p_value IS NULL OR p_value<0 THEN RAISE EXCEPTION 'ledger.settle: invalid cost' USING ERRCODE='22023';END IF;
    status:='invalid';priced:=0;charged:=0;shortfall:=0;
    SELECT * INTO h FROM public.ledger_hold WHERE id=p_hold_id;
    IF FOUND THEN
        PERFORM ledger.lock_creator((SELECT owner_id FROM public.ledger_account WHERE id=h.account_id));
        SELECT * INTO a FROM public.ledger_account WHERE id=h.account_id FOR NO KEY UPDATE;
        SELECT * INTO h FROM public.ledger_hold WHERE id=p_hold_id;
    END IF;
    IF h.id IS NULL THEN
        SELECT * INTO u FROM public.ledger_ai_usage x WHERE x.hold_id=p_hold_id
            AND x.created_at>=ledger.uuid_v7_time(p_hold_id)-interval '1 hour' LIMIT 1;
        IF NOT FOUND THEN RETURN NEXT;RETURN;END IF;
        IF u.outcome='settled' THEN
            status:='settled';state:='settled';priced:=u.priced;charged:=u.charged;shortfall:=u.shortfall;transfer_id:=u.transfer_id;
            RETURN NEXT;RETURN;
        END IF;
        status:='not_open';state:=u.outcome;
        IF NOT p_fixed AND (u.outcome='expired' OR u.usage->>'reason'='superseded') THEN
            PERFORM ledger.lock_creator((SELECT owner_id FROM public.ledger_account WHERE id=u.account_id));
            PERFORM 1 FROM public.ledger_account WHERE id=u.account_id FOR NO KEY UPDATE;
            SELECT * INTO u FROM public.ledger_ai_usage x WHERE x.id=u.id AND x.created_at=u.created_at FOR UPDATE;
            IF NOT u.late_settle_attempted THEN
                provider:=ceil(p_value::numeric/10000)::bigint;
                UPDATE public.ledger_ai_usage x SET late_settle_attempted=true,cost_nusd=p_value,
                    provider_m2z=provider,platform_m2z=-provider,usage=x.usage||coalesce(p_usage,'{}')
                    WHERE x.id=u.id AND x.created_at=u.created_at;
                IF provider>0 THEN INSERT INTO public.ledger_ai_split_queue(usage_id,developer_creator_id,provider_m2z,developer_m2z,platform_m2z)
                    VALUES(u.id,(SELECT developer_creator_id FROM public.ledger_app WHERE id=u.app_id),provider,0,-provider);END IF;
            END IF;
        END IF;
        RETURN NEXT;RETURN;
    END IF;
    IF p_fixed THEN
        IF p_value>h.amount THEN RAISE EXCEPTION 'ledger.settle_fixed: charge exceeds hold';END IF;
        priced:=p_value;provider:=0;dev:=0;cost:=0;
    ELSE
        IF h.rate_card_id IS NULL THEN RAISE EXCEPTION 'ledger.settle: fixed hold requires settle_fixed';END IF;
        SELECT * INTO terms FROM ledger.price(p_value,
            (SELECT platform_margin_bps FROM public.pricing_ratecard WHERE id=h.rate_card_id),h.dev_markup_bps,h.min_charge_2z);
        priced:=terms.priced;provider:=terms.provider_m2z;dev:=terms.dev_floor_m2z;cost:=p_value;
    END IF;
    IF h.expires_at<now() THEN terminal_reason:='expired';
    ELSIF EXISTS(SELECT 1 FROM public.ledger_ai_usage x WHERE x.app_id=h.app_id AND x.account_id=h.account_id
          AND x.logical_key=h.logical_key AND x.outcome='settled' AND x.created_at>=h.created_at-interval '1 day') THEN
        terminal_reason:='released';p_usage:=coalesce(p_usage,'{}')||'{"reason":"superseded"}'::jsonb;
    END IF;
    IF terminal_reason IS NOT NULL THEN
        u:=ledger.finish_hold(h.id,terminal_reason,0,0,provider,0,cost,h.window_start,p_usage);
        IF NOT p_fixed THEN UPDATE public.ledger_ai_usage x SET late_settle_attempted=true WHERE x.id=u.id AND x.created_at=u.created_at;END IF;
        status:='not_open';state:=terminal_reason;priced:=0;
        SELECT greatest(balance-held,0) INTO available FROM public.ledger_account WHERE id=a.id;
        cap_remaining:=ledger.cap_remaining(h.app_id,a.id,now());RETURN NEXT;RETURN;
    END IF;
    IF priced::numeric>10*greatest(h.amount::numeric,1000) THEN RAISE EXCEPTION 'ledger_settle_sanity';END IF;
    a:=ledger.heal_balance(a.id,(SELECT tuzis FROM public.g12f_creator WHERE id=a.owner_id));
    SELECT * INTO cap FROM public.ledger_spend_cap WHERE app_id=h.app_id AND account_id=a.id;
    ws:=h.window_start;
    ceiling:=9223372036854775807;
    IF cap.cap_m2z IS NOT NULL THEN
        ws:=CASE WHEN h.window_start IS NOT NULL AND h.cap_window_revision=cap.cap_window_revision
                 THEN h.window_start ELSE ledger.window_start(cap.period,now()) END;
        INSERT INTO public.ledger_spend_window(app_id,account_id,window_start) VALUES(h.app_id,a.id,ws)
            ON CONFLICT(app_id,account_id,window_start) DO UPDATE SET held_m2z=ledger_spend_window.held_m2z RETURNING * INTO w;
        room:=greatest(cap.cap_m2z-w.spent_m2z-w.held_m2z,0);
        ceiling:=CASE WHEN h.window_start IS NOT DISTINCT FROM ws THEN h.amount::numeric+room ELSE room END;
    END IF;
    charge:=greatest(least(priced,a.balance-(a.held-h.amount),greatest(ceiling,least(h.amount,priced))),0)::bigint;
    IF h.app_id<>'00000000-0000-4000-8000-000000000001'::uuid
       AND NOT coalesce((SELECT heal_enabled FROM public.ledger_config WHERE id),true)
       AND charge<least(priced,h.amount) THEN
        RAISE EXCEPTION 'ledger_hold_shortfall: reserved gateway amount cannot be collected';
    END IF;
    dev:=least(dev,greatest(charge-provider,0));
    u:=ledger.finish_hold(h.id,'settled',priced,charge,provider,dev,cost,ws,p_usage);
    status:='settled';state:='settled';charged:=u.charged;shortfall:=u.shortfall;transfer_id:=u.transfer_id;
    SELECT greatest(balance-held,0) INTO available FROM public.ledger_account WHERE id=a.id;
    IF ledger.debt(a.owner_id)>0 THEN available:=0;END IF;
    cap_remaining:=ledger.cap_remaining(h.app_id,a.id,now());RETURN NEXT;
END $$;

CREATE FUNCTION ledger.settle(p_hold_id uuid,p_cost_nusd bigint,p_usage jsonb DEFAULT '{}')
RETURNS TABLE(status text,state text,priced bigint,charged bigint,shortfall bigint,transfer_id bigint,available bigint,cap_remaining bigint)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
SELECT ledger.assert_gateway_database();
SELECT * FROM ledger.settle_internal(p_hold_id,p_cost_nusd,false,p_usage) $$;
CREATE FUNCTION ledger.settle_fixed(p_hold_id uuid,p_charge_m2z bigint,p_usage jsonb DEFAULT '{}')
RETURNS TABLE(status text,state text,priced bigint,charged bigint,shortfall bigint,transfer_id bigint,available bigint,cap_remaining bigint)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
SELECT * FROM ledger.settle_internal(p_hold_id,p_charge_m2z,true,p_usage) $$;

-- Gateway boundary: trusted Django functions are never granted. Requiring
-- both epochs and excluding the fixed first-party identity prevents the
-- gateway LOGIN from selecting Django's NULL-epoch/no-grant bypass.
CREATE FUNCTION ledger.hold(p_subject uuid,p_app_id uuid,p_amount bigint,p_hold_key text,p_logical_key text,
    p_attempt integer DEFAULT 0,p_ttl_s integer DEFAULT 300,p_account_epoch integer DEFAULT NULL,
    p_grant_generation integer DEFAULT NULL,p_model_id text DEFAULT NULL,p_rate_card_version bigint DEFAULT NULL,
    p_catalog_version text DEFAULT NULL,p_markup_bps integer DEFAULT 0,p_meta jsonb DEFAULT '{}')
RETURNS TABLE(hold_id uuid,status text,state text,available bigint,cap_remaining bigint,
              expires_at timestamptz,amount bigint,applied_markup_bps integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
    PERFORM ledger.assert_gateway_database();
    IF p_account_epoch IS NULL OR p_grant_generation IS NULL OR p_rate_card_version IS NULL
       OR p_app_id='00000000-0000-4000-8000-000000000001'::uuid THEN
        RAISE EXCEPTION 'ledger.hold: gateway claims and pricing snapshot required' USING ERRCODE='22023';
    END IF;
    RETURN QUERY SELECT * FROM ledger.hold_internal(p_subject,p_app_id,p_amount,p_hold_key,p_logical_key,
        p_attempt,p_ttl_s,p_account_epoch,p_grant_generation,p_model_id,p_rate_card_version,
        p_catalog_version,p_markup_bps,p_meta);
END $$;
CREATE FUNCTION ledger.extend(p_hold_id uuid,p_amount_to bigint DEFAULT NULL,p_ttl_s integer DEFAULT 300,
    p_account_epoch integer DEFAULT NULL,p_grant_generation integer DEFAULT NULL)
RETURNS TABLE(status text,state text,amount bigint,expires_at timestamptz,available bigint,cap_remaining bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
    PERFORM ledger.assert_gateway_database();
    IF p_account_epoch IS NULL OR p_grant_generation IS NULL
       OR EXISTS(SELECT 1 FROM public.ledger_hold h WHERE h.id=p_hold_id
                 AND h.app_id='00000000-0000-4000-8000-000000000001'::uuid) THEN
        RAISE EXCEPTION 'ledger.extend: gateway claims required' USING ERRCODE='22023';
    END IF;
    RETURN QUERY SELECT * FROM ledger.extend_internal(p_hold_id,p_amount_to,p_ttl_s,p_account_epoch,p_grant_generation);
END $$;

-- PostgreSQL roles are cluster-wide, while function privileges are per DB.
-- A shared group would give every namespace LOGIN access to every ledger.
CREATE FUNCTION ledger.configure_gateway_role(p_database text DEFAULT current_database()) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE gateway name := ('ai_gateway_' || substr(encode(sha256(convert_to(p_database,'UTF8')),'hex'),1,48))::name;
    r record; signature text;
BEGIN
    IF p_database IS NULL OR p_database='' THEN RAISE EXCEPTION 'database identity required'; END IF;
    SELECT * INTO r FROM pg_roles WHERE rolname=gateway;
    IF NOT FOUND THEN
        EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT',gateway);
    ELSIF r.rolcanlogin OR r.rolsuper OR r.rolcreaterole OR r.rolcreatedb
          OR r.rolreplication OR r.rolbypassrls OR r.rolinherit
          OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) THEN
        RAISE EXCEPTION 'ledger gateway group has unsafe existing attributes';
    END IF;
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_gateway') THEN
        REVOKE ALL ON SCHEMA ledger FROM ai_gateway;
        REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ledger FROM ai_gateway;
    END IF;
    EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ledger FROM %I',gateway);
    EXECUTE format('GRANT USAGE ON SCHEMA ledger TO %I',gateway);
    EXECUTE format('GRANT EXECUTE ON FUNCTION ledger.inquire(uuid,uuid),
        ledger.hold(uuid,uuid,bigint,text,text,integer,integer,integer,integer,text,bigint,text,integer,jsonb),
        ledger.extend(uuid,bigint,integer,integer,integer),
        ledger.settle(uuid,bigint,jsonb),ledger.release(uuid,jsonb) TO %I',gateway);
    FOREACH signature IN ARRAY ARRAY[
        'ledger.gateway_context(uuid,uuid,integer,integer)',
        'ledger.call_claim(uuid,uuid,integer,integer,uuid,text,text,jsonb)',
        'ledger.call_complete(uuid,uuid,integer,integer,uuid,jsonb,boolean)',
        'ledger.call_read(uuid,uuid,integer,integer,uuid)'
    ] LOOP
        IF to_regprocedure(signature) IS NOT NULL THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',signature,gateway);
        END IF;
    END LOOP;
END $$;
SELECT ledger.configure_gateway_role();
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
DO $$ BEGIN EXECUTE format('GRANT CREATE ON SCHEMA public TO %I',current_user);END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ledger FROM PUBLIC;
"""
