"""Frozen SQL used only by migration 0006_call_features.

A content-free per-call ``features`` object on the gateway's claim metadata.

Why: on 2026-10-05 a third-party app reported gpt-4o output that violated its
strict ``response_format`` json_schema, and nothing durable could say whether
the client had sent ``response_format`` at all -- ``request_meta`` held only
``model``/``requested_model``/``provider``/``catalog_version``/``metadata``.
``features`` records WHICH request features a call asked for, never what they
contained: a closed set of members, each a fixed enum, a validated schema
*name* (the same ``[A-Za-z0-9_-]{1,64}`` the gateway enforces), a boolean or a
count. No schema body, no prompt, no tool definition, no free text.

``gateway_metadata_valid`` is replaced in place (same signature, same
attributes; ``CREATE OR REPLACE`` keeps the owner and the empty ACL). It is
the 0004 body verbatim plus ONE branch: an OPTIONAL ``features`` key on the
request (non-completion) metadata that must be an object holding exactly the
eight members below, type-checked. Every existing rule is unchanged, so a
claim without ``features`` -- every claim an older gateway sends -- is valid
exactly as before, and ``features`` on a COMPLETION is still refused.

Members (all required, no others):

==============================  =============================================
``response_format``             ``"json_schema"`` | ``"json_object"`` | null
``response_format_strict``      boolean | null
``response_format_schema_name`` ``^[A-Za-z0-9_-]{1,64}$`` | null
``response_format_schema_bytes`` integer 0..2147483647 (0 when absent)
``tools``                       integer 0..2147483647
``max_output_tokens_strict``    boolean
``stream``                      boolean
``fallback``                    integer 0..2147483647 (count of models)
==============================  =============================================

No cross-member consistency is enforced (e.g. a ``json_object`` with a schema
name). This is observability: a refusal here fails the PAID call it describes,
so the check is exactly as strict as "content-free and well-typed" requires.

``call_envelope`` is NOT replaced: it already returns the whole stored
``request_meta`` as ``record.request``, so ``record.request.features`` is
there for ``call_read``/``call_claim`` with no further change. The gateway's
public projection (``rs/crates/f2z-ai/src/meter.rs`` ``project``) decides
whether ``GET /v1/calls/{id}`` shows it.

Deploy order: this migration ships before any gateway sends ``features``
(the gateway gates the emission behind ``ledger_features_meta``, default off),
because the 0004 body refuses an unknown key and ``call_claim`` would then
raise ``invalid gateway call claim`` on every call.
"""
SQL = r"""
CREATE OR REPLACE FUNCTION ledger.gateway_metadata_valid(p_value jsonb,p_completion boolean) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE k text;v jsonb;fk text;fv jsonb;
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
   ELSIF k='features' AND NOT p_completion THEN
     -- Content-free request features (0006): exactly these eight members.
     IF jsonb_typeof(v)<>'object' OR NOT (v ?& ARRAY['response_format','response_format_strict',
       'response_format_schema_name','response_format_schema_bytes','tools','max_output_tokens_strict',
       'stream','fallback']) THEN RETURN false;END IF;
     FOR fk,fv IN SELECT * FROM jsonb_each(v) LOOP
       IF fk='response_format' THEN
         IF fv<>'null'::jsonb AND (jsonb_typeof(fv)<>'string' OR (fv#>>'{}') NOT IN ('json_schema','json_object')) THEN RETURN false;END IF;
       ELSIF fk='response_format_schema_name' THEN
         IF fv<>'null'::jsonb AND (jsonb_typeof(fv)<>'string' OR (fv#>>'{}')!~'^[A-Za-z0-9_-]{1,64}$') THEN RETURN false;END IF;
       ELSIF fk='response_format_strict' THEN
         IF fv<>'null'::jsonb AND jsonb_typeof(fv)<>'boolean' THEN RETURN false;END IF;
       ELSIF fk IN ('max_output_tokens_strict','stream') THEN
         IF jsonb_typeof(fv)<>'boolean' THEN RETURN false;END IF;
       ELSIF fk IN ('response_format_schema_bytes','tools','fallback') THEN
         IF jsonb_typeof(fv)<>'number' OR (fv#>>'{}')!~'^[0-9]{1,10}$' OR (fv#>>'{}')::bigint>2147483647 THEN RETURN false;END IF;
       ELSE RETURN false;
       END IF;
     END LOOP;
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
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ledger FROM PUBLIC;
"""

# The 0004 body, verbatim (``_gateway_calls.py``): a rewind refuses
# ``features`` again. Metadata-only; stored rows are not touched either way.
REVERSE_SQL = r"""
CREATE OR REPLACE FUNCTION ledger.gateway_metadata_valid(p_value jsonb,p_completion boolean) RETURNS boolean
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
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ledger FROM PUBLIC;
"""
