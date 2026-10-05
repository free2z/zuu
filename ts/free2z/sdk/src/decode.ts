import { failure } from "./error.js";
import { object, string, uint } from "./json.js";
import type {
  Balance,
  EnforcementReason,
  Grant,
  CallRecord,
  Charge,
  ChatEvent,
  Estimate,
  Json,
  Model,
  ModelCapabilities,
  ModelPrices,
  Models,
  ObjectData,
  Purchase,
  Session,
  ToolCallDelta,
} from "./types.js";

const integerKeys = new Set([
  "catalog_version",
  "account_epoch",
  "grant_generation",
  "includes_markup_bps",
  "markup_bps",
  "context_window",
  "max_output_tokens",
  "input_tokens_estimate",
  "input_tokens",
  "cached_input_tokens",
  "cache_write_tokens",
  "output_tokens",
  "reasoning_tokens",
  "images",
  "tool_calls",
  "amount_zat",
  "below_minimum_zat",
  "confirmations_required",
  "amount_minor",
  "ttfb_timeout_ms",
  "confirmations",
  "required_confirmations",
  "quote_ttl_s",
  "charged2z",
  "collectedMilli2z",
  "shortfallMilli2z",
]);
function amountKey(key: string): boolean {
  return (
    integerKeys.has(key) ||
    key.endsWith("_2z") ||
    key.endsWith("_milli_2z_per_mtok")
  );
}
/** Amount names have meaning only at protocol schema locations. Caller
 * metadata and unknown extension objects must retain their own string values. */
function unsignedLocation(path: readonly string[]): boolean {
  const key = path[path.length - 1] ?? "";
  if (path.length === 1) return amountKey(key);
  if (
    path.length === 2 &&
    ["usage", "price", "prices", "charge", "rate"].includes(path[0]!)
  )
    return amountKey(key);
  if (path[0] === "models" && path[1] === "*") {
    return (
      (path.length === 3 || (path.length === 4 && path[2] === "prices")) &&
      amountKey(key)
    );
  }
  if (path[0] === "rail_data") {
    return (
      (path.length === 2 ||
        (path.length === 3 && path[1] === "rate") ||
        (path.length === 4 && path[1] === "payments" && path[2] === "*")) &&
      amountKey(key)
    );
  }
  return path.length === 2 && path[0] === "milli_2z_per_minor_unit";
}
/** Native IPC numbers are decimal strings; content and identifiers remain strings. */
export function nativeData(value: unknown): Json {
  function visit(value: unknown, path: readonly string[]): Json {
    if (path.length > 64) failure("response_too_complex");
    if (typeof value === "string" && unsignedLocation(path)) {
      if (!/^(0|[1-9][0-9]{0,19})$/.test(value)) failure("invalid_response");
      return uint(BigInt(value));
    }
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      typeof value === "bigint"
    )
      return value;
    if (typeof value === "number") {
      if (
        !Number.isFinite(value) ||
        (Number.isInteger(value) && !Number.isSafeInteger(value))
      )
        failure("unsafe_integer");
      if (unsignedLocation(path)) {
        if (!Number.isSafeInteger(value)) failure("invalid_response");
        return uint(BigInt(value));
      }
      return value;
    }
    if (Array.isArray(value)) return value.map((v) => visit(v, [...path, "*"]));
    const result: ObjectData = Object.create(null) as ObjectData;
    for (const [k, v] of Object.entries(object(value)))
      if (v !== undefined) result[k] = visit(v, [...path, k]);
    return result;
  }
  return visit(value, []);
}
function optionalUint(value: unknown): bigint | undefined {
  return value === null || value === undefined ? undefined : uint(value);
}
/** Unknown or inconsistent settlement never becomes a displayed zero charge. */
export function charge(
  data: ObjectData,
  record = false,
  success = false,
): Charge {
  if (data.charge !== undefined) {
    const value = object(data.charge);
    if (value.state === "pending") return { state: "pending" };
    if (value.state === "released" && uint(value.charged2z) === 0n)
      return { state: "released", charged2z: 0n };
    if (value.state === "charged") {
      const charged2z = uint(value.charged2z),
        receiptId = string(value.receiptId);
      if (charged2z === 0n || !receiptId) failure("invalid_response");
      const result: Charge = { state: "charged", charged2z, receiptId };
      const collected = optionalUint(value.collectedMilli2z),
        shortfall = optionalUint(value.shortfallMilli2z);
      if (collected !== undefined) result.collectedMilli2z = collected;
      if (shortfall !== undefined) result.shortfallMilli2z = shortfall;
      return result;
    }
    failure("invalid_response");
  }
  const state = record ? data.status : (data.settlement ?? "settled");
  if (state === "released") {
    return data.charged_2z === 0n && data.receipt_id == null
      ? { state: "released", charged2z: 0n }
      : { state: "pending" };
  }
  if (state !== "settled" && !(record && state === "settled_partial"))
    return { state: "pending" };
  const charged = optionalUint(data.charged_2z),
    receipt = data.receipt_id;
  if (charged === undefined) return { state: "pending" };
  if (
    charged === 0n &&
    !success &&
    data.partial !== true &&
    (receipt === undefined || receipt === null)
  ) {
    return { state: "released", charged2z: 0n };
  }
  if (charged === 0n || typeof receipt !== "string" || receipt.length === 0)
    return { state: "pending" };
  const collected = optionalUint(data.collected_milli_2z),
    shortfall = optionalUint(data.shortfall_milli_2z);
  if (
    collected !== undefined &&
    shortfall !== undefined &&
    collected + shortfall !== charged * 1000n
  )
    return { state: "pending" };
  const result: Charge = {
    state: "charged",
    charged2z: charged,
    receiptId: receipt,
  };
  if (collected !== undefined) result.collectedMilli2z = collected;
  if (shortfall !== undefined) result.shortfallMilli2z = shortfall;
  return result;
}
function validated(value: unknown): ObjectData {
  const d = object(value);
  function check(value: unknown, path: readonly string[]): void {
    if (path.length > 64) failure("response_too_complex");
    if (value == null) return;
    if (unsignedLocation(path)) {
      uint(value);
      return;
    }
    if (Array.isArray(value))
      for (const child of value) check(child, [...path, "*"]);
    else if (typeof value === "object")
      for (const [k, child] of Object.entries(value))
        check(child, [...path, k]);
  }
  check(d, []);
  return d;
}
function utcTimestamp(value: string): boolean {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|\+00:00)$/.exec(
      value,
    );
  if (!m) return false;
  const year = Number(m[1]),
    month = Number(m[2]),
    day = Number(m[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days =
    month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days &&
    Number(m[4]) < 24 &&
    Number(m[5]) < 60 &&
    Number(m[6]) <= 60
  );
}
const enforcementReasons: readonly string[] = [
  "ok",
  "platform_disabled",
  "ledger_cutover_pending",
  "ledger_cap_pending",
];
function enforcementReason(
  value: unknown,
  enforced: boolean,
): EnforcementReason | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") failure("invalid_response");
  const reason = (
    enforcementReasons.includes(value) ? value : "unknown"
  ) as EnforcementReason;
  if ((reason === "ok") !== enforced) failure("invalid_response");
  return reason;
}
export function grant(value: unknown): Grant {
  const d = validated(value);
  if (
    typeof d.enforced !== "boolean" ||
    !Array.isArray(d.scopes) ||
    !["day", "week", "month", "total"].includes(String(d.cap_period))
  )
    failure("invalid_response");
  const sub = string(d.sub),
    client = string(d.client_id);
  const generation = uint(d.grant_generation),
    asOf = string(d.as_of);
  if (
    !sub ||
    !client ||
    generation === 0n ||
    !d.scopes.includes("ai:invoke") ||
    !utcTimestamp(asOf)
  )
    failure("invalid_response");
  const reason = enforcementReason(d.enforcement_reason, d.enforced);
  return {
    sub,
    client_id: client,
    account_epoch: uint(d.account_epoch),
    grant_generation: generation,
    scopes: d.scopes.map(string),
    spend_cap_2z: d.spend_cap_2z === null ? null : uint(d.spend_cap_2z),
    cap_period: d.cap_period as Grant["cap_period"],
    enforced: d.enforced,
    ...(reason === undefined ? {} : { enforcement_reason: reason }),
    as_of: asOf,
  };
}
export function balance(value: unknown): Balance {
  const d = validated(value);
  return {
    available_milli_2z: uint(d.available_milli_2z),
    held_milli_2z: uint(d.held_milli_2z),
    balance_milli_2z: uint(d.balance_milli_2z),
    debt_milli_2z: uint(d.debt_milli_2z),
    as_of: string(d.as_of),
  };
}
export function session(value: unknown): Session {
  const d = validated(value);
  if (
    typeof d.signedIn !== "boolean" ||
    !Array.isArray(d.grantedScopes) ||
    (d.persistence !== "persistent" && d.persistence !== "memory_only")
  )
    failure("invalid_response");
  return {
    signedIn: d.signedIn,
    subject: d.subject === null ? null : string(d.subject),
    grantedScopes: d.grantedScopes.map(string),
    persistence: d.persistence,
    generation: string(d.generation),
  };
}
export function purchase(value: unknown): Purchase {
  const d = validated(value),
    price = object(d.price);
  return {
    ...d,
    id: string(d.id),
    rail: string(d.rail),
    status: string(d.status),
    quantity_2z: uint(d.quantity_2z),
    price: {
      currency: string(price.currency),
      amount_minor: uint(price.amount_minor),
    },
    credited_milli_2z: optionalUint(d.credited_milli_2z) ?? null,
    credited_at: d.credited_at == null ? null : string(d.credited_at),
    created_at: typeof d.created_at === "string" ? d.created_at : "",
    expires_at: typeof d.expires_at === "string" ? d.expires_at : "",
    rail_data: object(d.rail_data ?? {}),
  };
}
export function callRecord(value: unknown): CallRecord {
  const d = validated(value);
  return {
    ...d,
    call_id: string(d.call_id),
    status: string(d.status),
    charge: charge(d, true),
  };
}
const capabilityKeys = [
  "vision",
  "tools",
  "reasoning",
  "structured_output",
  "strict_tools",
] as const;
/** Absent or `null` is `{}`: nothing declared, so nothing supported. A
 * declared member must be a boolean — a string `"true"` would otherwise read
 * as unsupported in an `=== true` check without anyone noticing. */
function capabilities(value: Json | undefined): ModelCapabilities {
  const result = Object.create(null) as ModelCapabilities;
  if (value == null) return result;
  for (const [key, member] of Object.entries(object(value))) {
    if (member === undefined) continue;
    if ((capabilityKeys as readonly string[]).includes(key)) {
      if (member === null) continue;
      if (typeof member !== "boolean") failure("invalid_response");
    }
    result[key] = member;
  }
  return result;
}
/** Absent or `null` is `{}`. Amount-named rates were checked as unsigned by
 * `validated`; `null` reads as absent. Other members pass through. */
function prices(value: Json | undefined): ModelPrices {
  const result = Object.create(null) as ModelPrices;
  if (value == null) return result;
  for (const [key, member] of Object.entries(object(value))) {
    if (member === undefined) continue;
    if (unsignedLocation(["models", "*", "prices", key])) {
      if (member !== null) result[key] = uint(member);
    } else result[key] = member;
  }
  return result;
}
function model(value: unknown): Model {
  const {
    id,
    provider,
    display_name: displayName,
    context_window: contextWindow,
    max_output_tokens: maxOutputTokens,
    capabilities: declared,
    prices: rates,
    min_charge_2z: minCharge,
    ttfb_timeout_ms: ttfb,
    ...rest
  } = object(value);
  const result: Model = {
    ...rest,
    id: string(id),
    capabilities: capabilities(declared),
    prices: prices(rates),
  };
  if (!result.id) failure("invalid_response");
  if (provider != null) result.provider = string(provider);
  if (displayName != null) result.display_name = string(displayName);
  if (contextWindow != null) result.context_window = uint(contextWindow);
  if (maxOutputTokens != null) result.max_output_tokens = uint(maxOutputTokens);
  if (minCharge != null) result.min_charge_2z = uint(minCharge);
  if (ttfb != null) result.ttfb_timeout_ms = uint(ttfb);
  return result;
}
/** Typed members are checked; `null` reads as absent, as the Rust SDK reads
 * it. Unknown members — of the answer, a model, its capabilities or prices —
 * pass through. */
export function models(value: unknown): Models {
  const d = validated(value);
  const { includes_markup_bps: markup, ...rest } = d;
  if (!Array.isArray(d.models)) failure("invalid_response");
  const result: Models = {
    ...rest,
    catalog_version: uint(d.catalog_version),
    models: d.models.map(model),
  };
  if (markup != null) result.includes_markup_bps = uint(markup);
  return result;
}
/** The budget fields are optional on decode (chat-api.md §6). `null` reads as
 * absent, as the Rust proto reads it, except for `cap_remaining_milli_2z`,
 * where `null` is "uncapped" and stays apart from absent. */
export function estimate(value: unknown): Estimate {
  const d = validated(value);
  const {
    available_milli_2z: available,
    cap_remaining_milli_2z: capRemaining,
    min_charge_2z: minCharge,
    catalog_version: catalogVersion,
    ...rest
  } = d;
  const result: Estimate = {
    ...rest,
    model: string(d.model),
    input_tokens: uint(d.input_tokens),
    max_output_tokens: uint(d.max_output_tokens),
    hold_2z: uint(d.hold_2z),
  };
  if (available != null) result.available_milli_2z = uint(available);
  if (capRemaining !== undefined)
    result.cap_remaining_milli_2z =
      capRemaining === null ? null : uint(capRemaining);
  if (minCharge != null) result.min_charge_2z = uint(minCharge);
  if (catalogVersion != null) result.catalog_version = uint(catalogVersion);
  return result;
}
/** A tool call's position: a u32, as a JSON integer (bigint here) or, across
 * native IPC, a canonical decimal string. */
function toolIndex(value: unknown): number {
  if (typeof value === "string" && /^(0|[1-9][0-9]{0,9})$/.test(value))
    value = BigInt(value);
  if (typeof value !== "bigint" || value < 0n || value > 4_294_967_295n)
    failure("invalid_response");
  return Number(value);
}
export function event(type: string, value: unknown): ChatEvent | undefined {
  if (
    ![
      "meta",
      "delta",
      "tool_call_delta",
      "tool_call",
      "usage",
      "done",
      "error",
    ].includes(type)
  )
    return undefined;
  const d = validated(value);
  switch (type) {
    case "meta":
      return {
        ...d,
        type,
        call_id: string(d.call_id),
        model: string(d.model),
        hold_2z: uint(d.hold_2z),
      };
    case "delta":
      return { type, text: string(d.text) };
    case "tool_call_delta": {
      const fragment: { type: "tool_call_delta" } & ToolCallDelta = {
        type,
        index: toolIndex(d.index),
        arguments: d.arguments === undefined ? "" : string(d.arguments),
      };
      if (d.id !== undefined) fragment.id = string(d.id);
      if (d.name !== undefined) fragment.name = string(d.name);
      return fragment;
    }
    case "tool_call":
      return {
        type,
        id: string(d.id),
        name: string(d.name),
        arguments: string(d.arguments),
      };
    case "usage":
      return {
        ...d,
        type,
        usage: object(d.usage),
        source: typeof d.source === "string" ? d.source : "unknown",
      };
    case "done":
      return {
        ...d,
        type,
        settlement: typeof d.settlement === "string" ? d.settlement : "settled",
        finish_reason: string(d.finish_reason),
        charge: charge(d, false, true),
      };
    case "error":
      return {
        ...d,
        type,
        settlement: typeof d.settlement === "string" ? d.settlement : "settled",
        code: string(d.code),
        partial: d.partial === true,
        charge:
          d.code === "delivery_aborted" ? { state: "pending" } : charge(d),
      };
    default:
      return undefined;
  }
}
