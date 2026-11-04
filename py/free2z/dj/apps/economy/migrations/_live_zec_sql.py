"""Note-backed v3 issuance proof; original receipt/journal and v1/v2 proof retained."""

SQL = r"""
CREATE FUNCTION economy.routing_note_memo(p_note uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE raw bytea;size integer;item record;value text;decoded text;result jsonb:='{}';seen text[]:='{}';
BEGIN
 SELECT decode(coalesce(n.memo_hex,(SELECT d.evidence->>'memo_hex' FROM public.economy_zecnotedisposition d
   WHERE d.note_id=n.id AND d.event_key='memo-hydration:'||n.id::text)),'hex') INTO raw
 FROM public.economy_capturedzecnote n WHERE n.id=p_note;
 IF raw IS NULL OR get_byte(raw,0)>=245 THEN RETURN NULL; END IF;
 size:=length(raw);
 WHILE size>0 AND get_byte(raw,size-1)=0 LOOP size:=size-1; END LOOP;
 -- json_each retains raw JSON values. Decode only routing fields: ignored
 -- historical values or invalid optional codes cannot poison a valid act/id.
 -- PostgreSQL eagerly decodes every JSON scalar even in json_each. Replace
 -- unstorable escapes in this temporary projection; raw evidence stays exact.
 -- Such characters cannot name a valid recipient or ASCII promotion code.
 decoded:=convert_from(substring(raw FROM 1 FOR size),'UTF8');
 decoded:=regexp_replace(decoded,'(?<!\\)((?:\\\\)*)\\u0000','\1\\u0001','gi');
 decoded:=regexp_replace(decoded,'(?<!\\)((?:\\\\)*)\\u[dD][89aAbB][0-9a-fA-F]{2}(?!\\u[dD][cCdDeEfF][0-9a-fA-F]{2})','\1\\u0001','g');
 decoded:=regexp_replace(decoded,'(?<!\\u[dD][89aAbB][0-9a-fA-F]{2})(?<!\\)((?:\\\\)*)\\u[dD][cCdDeEfF][0-9a-fA-F]{2}','\1\\u0001','g');
 FOR item IN SELECT * FROM json_each(decoded::json) LOOP
   IF item.key=ANY(seen) OR item.key NOT IN ('act','id','intent','proof','ref','promo') THEN RETURN NULL; END IF;
   seen:=array_append(seen,item.key);
   IF item.key IN ('act','id') THEN
     IF json_typeof(item.value)<>'string' THEN RETURN NULL; END IF;
     value:=item.value#>>'{}';
     IF value ~ ('['||chr(1)||'-'||chr(31)||chr(127)||']') THEN RETURN NULL; END IF;
     result:=result||jsonb_build_object(item.key,value);
   ELSIF item.key='promo' AND json_typeof(item.value)='string' THEN
     BEGIN value:=item.value#>>'{}';
     EXCEPTION WHEN untranslatable_character OR invalid_text_representation THEN value:=NULL; END;
     IF btrim(value) COLLATE "C" ~ '^[A-Za-z0-9_-]{1,64}$' THEN
       result:=result||jsonb_build_object('promo',upper(btrim(value) COLLATE "C"));
     END IF;
   END IF;
 END LOOP;
 RETURN result;
 EXCEPTION WHEN untranslatable_character OR invalid_text_representation OR invalid_parameter_value THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION economy.routing_note_memo(uuid) FROM PUBLIC;
CREATE OR REPLACE FUNCTION economy.guard_note_disposition() RETURNS trigger
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
  IF NOT EXISTS(SELECT 1 FROM public.economy_fundingreservation f
     WHERE f.id=NEW.funding_id AND f.state='issued' AND f.recipient_id=NEW.actor_id
     AND f.amount_m2z=r.tuzis_credited*1000
     AND f.external_receipt->>'provider_reference'='zec:'||n.txid||':'||n.pool||':'||n.output_index::text
     AND (
       -- Retained original fixed-contract proof, unchanged for old issuances.
       (f.external_receipt->>'pricing_method_version' IS DISTINCT FROM 'zec-funding-v3'
         AND EXISTS(SELECT 1 FROM public.purchases_purchaseintent i WHERE i.id=NEW.intent_id
         AND i.creator_id=NEW.actor_id AND i.rail='zec' AND i.status='credited'
         AND f.id::text=i.quote->>'funding_reservation_id'))
       OR (
         f.external_receipt->>'pricing_method_version'='zec-funding-v3'
         AND f.external_receipt->>'captured_note_id'=n.id::text
         AND f.external_receipt->>'recipient_reference'='free2z-account:'||NEW.actor_id::text
         AND r.instant=false AND r.confirmations_at_credit>=3
         AND coalesce((SELECT binding.actor_id FROM public.economy_zecnotedisposition binding
           WHERE binding.note_id=n.id AND (binding.event_key='payment-notice:'||n.id::text OR binding.kind='pending_confirmation')
             AND binding.actor_id IS NOT NULL ORDER BY binding.created_at,binding.id LIMIT 1),NEW.actor_id)=NEW.actor_id
         AND NOT EXISTS(SELECT 1 FROM public.economy_zecnotedisposition d
           WHERE d.note_id=n.id AND d.kind='revoked')
         AND (economy.routing_note_memo(n.id))->>'act'='buy_2z'
         AND EXISTS(SELECT 1 FROM public.g12f_creator c WHERE c.id=NEW.actor_id AND c.is_active
           AND c.username=(economy.routing_note_memo(n.id))->>'id')
         AND EXISTS(SELECT 1 FROM public.pricing_zecpricesnapshot p
           WHERE p.id::text=f.external_receipt->>'snapshot_id'
             AND p.created_at BETWEEN (f.external_receipt->>'processed_at')::timestamptz-interval '120 seconds' AND (f.external_receipt->>'processed_at')::timestamptz
             AND (f.external_receipt->>'processed_at')::timestamptz BETWEEN transaction_timestamp() AND statement_timestamp()
             AND p.num_sources>=2 AND jsonb_typeof(p.sources)='object'
             AND (SELECT count(*) FROM jsonb_object_keys(p.sources))=p.num_sources
             AND p.sources=f.external_receipt->'sources'
             AND p.spread>=0 AND p.spread<1 AND p.zec_usd>0
             AND (f.external_receipt->>'spread')::numeric>=0
             AND (f.external_receipt->>'spread')::numeric<1
             AND p.tuzis_per_zec=floor(p.zec_usd*(1-p.spread)*1000000)/10000
             AND r.tuzis_per_zec=(f.external_receipt->>'tuzis_per_zec')::numeric
             AND (f.external_receipt->>'base_tuzis_per_zec')::numeric=floor(p.zec_usd*(1-(f.external_receipt->>'spread')::numeric)*1000000)/10000
             AND r.tuzis_per_zec=floor((f.external_receipt->>'base_tuzis_per_zec')::numeric*(f.external_receipt->'promotion'->>'multiplier')::numeric*10000)/10000
             AND (f.external_receipt->'promotion'->>'requested_code') IS NOT DISTINCT FROM economy.routing_note_memo(n.id)->>'promo'
             AND (
               (f.external_receipt->'promotion'->>'id' IS NULL
                 AND (f.external_receipt->'promotion'->>'multiplier')::numeric=1
                 AND NOT EXISTS(SELECT 1 FROM public.economy_zecpromotion offer
                   WHERE offer.enabled AND offer.ends_at>(f.external_receipt->>'processed_at')::timestamptz
                     AND (offer.starts_at IS NULL OR offer.starts_at<=(f.external_receipt->>'processed_at')::timestamptz)
                     AND (offer.code='' OR offer.code=f.external_receipt->'promotion'->>'requested_code')))
               OR EXISTS(SELECT 1 FROM public.economy_zecpromotion offer
                 WHERE offer.id::text=f.external_receipt->'promotion'->>'id'
                   AND offer.enabled AND offer.ends_at>(f.external_receipt->>'processed_at')::timestamptz
                   AND (offer.starts_at IS NULL OR offer.starts_at<=(f.external_receipt->>'processed_at')::timestamptz)
                   AND (offer.code='' OR offer.code=f.external_receipt->'promotion'->>'requested_code')
                   AND offer.multiplier=(f.external_receipt->'promotion'->>'multiplier')::numeric
                   AND offer.title=f.external_receipt->'promotion'->>'title'
                   AND nullif(offer.code,'') IS NOT DISTINCT FROM f.external_receipt->'promotion'->>'code'
                   AND offer.starts_at IS NOT DISTINCT FROM (f.external_receipt->'promotion'->>'starts_at')::timestamptz
                   AND offer.ends_at=(f.external_receipt->'promotion'->>'ends_at')::timestamptz
                   AND NOT EXISTS(SELECT 1 FROM public.economy_zecpromotion better
                     WHERE better.enabled AND better.ends_at>(f.external_receipt->>'processed_at')::timestamptz
                       AND (better.starts_at IS NULL OR better.starts_at<=(f.external_receipt->>'processed_at')::timestamptz)
                       AND (better.code='' OR better.code=f.external_receipt->'promotion'->>'requested_code')
                       AND (better.multiplier>offer.multiplier OR (better.multiplier=offer.multiplier AND better.code='' AND offer.code<>''))))
             )
             AND f.sale_nusd=ceil(n.amount_zatoshi::numeric*p.zec_usd*10)
             -- Same nearest/even three-decimal quantization as ledger.to_tuzis.
             AND r.tuzis_credited*1000=trunc(n.amount_zatoshi::numeric*r.tuzis_per_zec/100000)
               +CASE WHEN mod(n.amount_zatoshi::numeric*r.tuzis_per_zec/100000,1)>0.5
                    OR (mod(n.amount_zatoshi::numeric*r.tuzis_per_zec/100000,1)=0.5
                      AND mod(trunc(n.amount_zatoshi::numeric*r.tuzis_per_zec/100000),2)=1)
                  THEN 1 ELSE 0 END)
       )
     )) THEN RAISE EXCEPTION 'global issuance lacks exact original funding proof'; END IF;
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
"""

REVERSE = r"""
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.economy_economicpolicy WHERE version=1)
   OR EXISTS(SELECT 1 FROM public.economy_fundingreservation
      WHERE external_receipt->>'pricing_method_version'='zec-funding-v3') THEN
  RAISE EXCEPTION 'history prevents reversal of live ZEC funding';
 END IF;
END $$;

CREATE OR REPLACE FUNCTION economy.guard_note_disposition() RETURNS trigger
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
"""

REVERSE += "\nDROP FUNCTION economy.routing_note_memo(uuid);\n"
