//! [`OrderedJson`]: a JSON value that keeps object members in the order the
//! caller wrote them.
//!
//! # Why not `serde_json::Value`
//!
//! A JSON Schema's member order is not part of its meaning, but it is part of
//! what a model sees: OpenAI's structured output emits the reply's keys **in
//! schema order**, so an app that declares `reasoning` before `answer` relies
//! on getting them in that order. `serde_json::Value` without serde_json's
//! `preserve_order` feature is a `BTreeMap` and sorts members by name, and
//! that feature cannot be turned on here: it requires `std` (this crate is
//! `no_std` + `alloc`), and Cargo would unify it into every crate that links
//! serde_json alongside this one — a behaviour change to unrelated code that
//! nothing in those crates asked for (zuu#1132).
//!
//! So the tool `parameters` and the `response_format` schema of a
//! [`crate::ChatRequest`] are this type: a JSON tree whose objects are a list
//! of members in arrival order. It serializes in that order, and a gateway
//! that builds the provider body from it sends the caller's order.
//!
//! # Duplicate member names
//!
//! JSON text may repeat a member name. As `serde_json::Value` (and its
//! `preserve_order` map) does, the **last** value wins; here it stays at the
//! position the name **first** appeared, which is what serde_json's
//! `preserve_order` map does. An `OrderedJson` never holds two members of one
//! name, however it was built.
//!
//! # Equality
//!
//! `==` is order-**sensitive**: `{"a":1,"b":2}` and `{"b":2,"a":1}` differ,
//! because they produce different provider requests. Compare
//! [`OrderedJson::to_value`] for JSON-data-model equality.

use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;
use core::fmt;

use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::ser::{Serialize, SerializeMap, SerializeSeq, Serializer};
use serde_json::{Map, Number, Value};

/// A JSON value whose objects keep their members in insertion order. See the
/// [module documentation](self).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderedJson(Node);

#[derive(Clone, Debug, PartialEq, Eq)]
enum Node {
    Null,
    Bool(bool),
    Number(Number),
    String(String),
    Array(Vec<Node>),
    /// Distinct names, in insertion order.
    Object(Vec<(String, Node)>),
}

impl Node {
    /// An object from members in order: on a repeated name the last value
    /// wins, at the first name's position. `O(n log n)`, so a client cannot
    /// make decoding quadratic with a wide object.
    fn object(members: impl IntoIterator<Item = (String, Node)>) -> Self {
        let mut out: Vec<(String, Node)> = Vec::new();
        let mut index: BTreeMap<String, usize> = BTreeMap::new();
        for (name, value) in members {
            match index.get(&name).and_then(|&at| out.get_mut(at)) {
                Some(slot) => slot.1 = value,
                None => {
                    index.insert(name.clone(), out.len());
                    out.push((name, value));
                }
            }
        }
        Self::Object(out)
    }

    fn from_value(value: Value) -> Self {
        match value {
            Value::Null => Self::Null,
            Value::Bool(b) => Self::Bool(b),
            Value::Number(n) => Self::Number(n),
            Value::String(s) => Self::String(s),
            Value::Array(items) => Self::Array(items.into_iter().map(Self::from_value).collect()),
            // A `Map` has distinct keys already.
            Value::Object(map) => Self::Object(
                map.into_iter()
                    .map(|(k, v)| (k, Self::from_value(v)))
                    .collect(),
            ),
        }
    }

    fn to_value(&self) -> Value {
        match self {
            Self::Null => Value::Null,
            Self::Bool(b) => Value::Bool(*b),
            Self::Number(n) => Value::Number(n.clone()),
            Self::String(s) => Value::String(s.clone()),
            Self::Array(items) => Value::Array(items.iter().map(Self::to_value).collect()),
            Self::Object(members) => Value::Object(
                members
                    .iter()
                    .map(|(k, v)| (k.clone(), v.to_value()))
                    .collect::<Map<String, Value>>(),
            ),
        }
    }

    fn sorted(&self) -> Self {
        match self {
            Self::Array(items) => Self::Array(items.iter().map(Self::sorted).collect()),
            Self::Object(members) => {
                let mut members: Vec<(String, Node)> = members
                    .iter()
                    .map(|(k, v)| (k.clone(), v.sorted()))
                    .collect();
                // `String`'s `Ord`: bytewise, exactly `BTreeMap<String, _>`'s
                // order. Names are distinct, so stability is moot.
                members.sort_by(|a, b| a.0.cmp(&b.0));
                Self::Object(members)
            }
            leaf => leaf.clone(),
        }
    }
}

impl OrderedJson {
    /// `null`.
    pub const NULL: Self = Self(Node::Null);

    /// An object of `members`, in order. A repeated name keeps its first
    /// position and its last value (see the [module documentation](self)).
    pub fn object<K: Into<String>>(members: impl IntoIterator<Item = (K, OrderedJson)>) -> Self {
        Self(Node::object(
            members.into_iter().map(|(k, v)| (k.into(), v.0)),
        ))
    }

    /// An array of `items`, in order.
    pub fn array(items: impl IntoIterator<Item = OrderedJson>) -> Self {
        Self(Node::Array(items.into_iter().map(|v| v.0).collect()))
    }

    /// Whether this is a JSON object.
    #[must_use]
    pub fn is_object(&self) -> bool {
        matches!(self.0, Node::Object(_))
    }

    /// This value as a `serde_json::Value`. **Member order is the `Value`'s**
    /// (sorted by name, unless the final binary enables serde_json's
    /// `preserve_order`): for reading and comparing, never for re-sending.
    #[must_use]
    pub fn to_value(&self) -> Value {
        self.0.to_value()
    }

    /// A copy with every object's members sorted by name, recursively —
    /// bytewise, as a `serde_json::Value` without `preserve_order` orders
    /// them. Serialized, it is byte-for-byte what a `Value` holding the same
    /// JSON serializes to; that is what keeps the gateway's idempotency
    /// fingerprint unchanged by zuu#1132.
    #[must_use]
    pub fn with_sorted_keys(&self) -> Self {
        Self(self.0.sorted())
    }
}

impl From<Value> for OrderedJson {
    /// A `Value` has already lost the caller's order (unless `preserve_order`
    /// is on); this keeps whatever order it has.
    fn from(value: Value) -> Self {
        Self(Node::from_value(value))
    }
}

impl From<&OrderedJson> for Value {
    fn from(value: &OrderedJson) -> Self {
        value.to_value()
    }
}

impl From<bool> for OrderedJson {
    fn from(value: bool) -> Self {
        Self(Node::Bool(value))
    }
}

impl From<&str> for OrderedJson {
    fn from(value: &str) -> Self {
        Self(Node::String(value.into()))
    }
}

impl From<String> for OrderedJson {
    fn from(value: String) -> Self {
        Self(Node::String(value))
    }
}

impl core::str::FromStr for OrderedJson {
    type Err = serde_json::Error;

    /// Parse JSON text, keeping member order.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        serde_json::from_str(text)
    }
}

impl fmt::Display for OrderedJson {
    /// Compact JSON text, members in order.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = serde_json::to_string(self).map_err(|_| fmt::Error)?;
        f.write_str(&text)
    }
}

impl Serialize for OrderedJson {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

impl Serialize for Node {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Null => serializer.serialize_unit(),
            Self::Bool(b) => serializer.serialize_bool(*b),
            Self::Number(n) => n.serialize(serializer),
            Self::String(s) => serializer.serialize_str(s),
            Self::Array(items) => {
                let mut seq = serializer.serialize_seq(Some(items.len()))?;
                for item in items {
                    seq.serialize_element(item)?;
                }
                seq.end()
            }
            Self::Object(members) => {
                let mut map = serializer.serialize_map(Some(members.len()))?;
                for (name, value) in members {
                    map.serialize_entry(name, value)?;
                }
                map.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for OrderedJson {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Node::deserialize(deserializer).map(Self)
    }
}

impl<'de> Deserialize<'de> for Node {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(NodeVisitor)
    }
}

/// The same decisions as `serde_json::Value`'s own visitor, so a value decodes
/// to the same JSON either way — only member order differs.
struct NodeVisitor;

impl<'de> Visitor<'de> for NodeVisitor {
    type Value = Node;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("any valid JSON value")
    }

    fn visit_bool<E>(self, v: bool) -> Result<Node, E> {
        Ok(Node::Bool(v))
    }

    fn visit_i64<E>(self, v: i64) -> Result<Node, E> {
        Ok(Node::Number(v.into()))
    }

    fn visit_u64<E>(self, v: u64) -> Result<Node, E> {
        Ok(Node::Number(v.into()))
    }

    // Not reached from JSON text, but `serde_json::from_value` under
    // `arbitrary_precision` hands an integer wider than 64 bits to these (the
    // Tauri plugin decodes its IPC `Value` this way). `Value`'s visitor takes
    // them through `Number`'s own decoder; so does this.
    fn visit_i128<E: de::Error>(self, v: i128) -> Result<Node, E> {
        Number::deserialize(de::value::I128Deserializer::<E>::new(v)).map(Node::Number)
    }

    fn visit_u128<E: de::Error>(self, v: u128) -> Result<Node, E> {
        Number::deserialize(de::value::U128Deserializer::<E>::new(v)).map(Node::Number)
    }

    fn visit_f64<E>(self, v: f64) -> Result<Node, E> {
        // `Value` maps a non-finite float to `null`; so does this.
        Ok(Number::from_f64(v).map_or(Node::Null, Node::Number))
    }

    fn visit_str<E: de::Error>(self, v: &str) -> Result<Node, E> {
        Ok(Node::String(v.into()))
    }

    fn visit_string<E>(self, v: String) -> Result<Node, E> {
        Ok(Node::String(v))
    }

    fn visit_none<E>(self) -> Result<Node, E> {
        Ok(Node::Null)
    }

    fn visit_some<D: Deserializer<'de>>(self, d: D) -> Result<Node, D::Error> {
        Node::deserialize(d)
    }

    fn visit_unit<E>(self) -> Result<Node, E> {
        Ok(Node::Null)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Node, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = seq.next_element()? {
            items.push(item);
        }
        Ok(Node::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Node, A::Error> {
        let Some(first) = map.next_key::<String>()? else {
            return Ok(Node::Object(Vec::new()));
        };
        // serde_json's `arbitrary_precision` feature — off in this workspace,
        // but Cargo unifies it in from any crate a consumer links — hands a
        // number to `deserialize_any` as a one-member map under a private
        // key. `Value` decodes that map as the number; so must this, or
        // `"minimum":0.5` would be forwarded as an object. Without the
        // feature the key is an ordinary member name, as it is for `Value`.
        if first == NUMBER_TOKEN && arbitrary_precision() {
            let text: String = map.next_value()?;
            return text
                .parse::<Number>()
                .map(Node::Number)
                .map_err(de::Error::custom);
        }
        // Likewise `raw_value` (on in the gateway, via sqlx): `Value` reads a
        // member named by its private token as a string of JSON text and
        // decodes that text in the object's place. Nobody writes that on
        // purpose, but a schema that did decoded so before zuu#1132, and
        // decoding it the same way keeps its idempotency fingerprint.
        if first == RAW_TOKEN && raw_value() {
            let text: String = map.next_value()?;
            return serde_json::from_str::<Node>(&text).map_err(de::Error::custom);
        }
        let mut members = alloc::vec![(first, map.next_value::<Node>()?)];
        while let Some(entry) = map.next_entry::<String, Node>()? {
            members.push(entry);
        }
        Ok(Node::object(members))
    }
}

/// serde_json's private map key for an `arbitrary_precision` number
/// (`serde_json::number::TOKEN`, not exported).
const NUMBER_TOKEN: &str = "$serde_json::private::Number";

/// Whether the serde_json this binary links has `arbitrary_precision`: under
/// it a `Value` keeps a number's text (`1e2` re-serializes as `1e+2`),
/// without it the `f64` (`100.0`).
/// Asked only when [`NUMBER_TOKEN`] arrives as a key, so never in practice.
fn arbitrary_precision() -> bool {
    serde_json::from_str::<Value>("1e2")
        .is_ok_and(|v| serde_json::to_string(&v).is_ok_and(|text| text != "100.0"))
}

/// serde_json's private map key for a `RawValue` (`serde_json::raw::TOKEN`,
/// not exported).
const RAW_TOKEN: &str = "$serde_json::private::RawValue";

/// Whether the serde_json this binary links has `raw_value`: under it a
/// `Value` decodes [`RAW_TOKEN`]'s string as JSON. Asked only when that key
/// arrives.
fn raw_value() -> bool {
    serde_json::from_str::<Value>(r#"{"$serde_json::private::RawValue":"1"}"#)
        .is_ok_and(|v| v.is_number())
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::string::ToString;
    use serde_json::json;

    const SCHEMA: &str = r#"{"type":"object","properties":{"reasoning":{"type":"string"},"answer":{"type":"number"}},"required":["reasoning","answer"]}"#;

    #[test]
    fn member_order_survives_a_round_trip() {
        let parsed: OrderedJson = SCHEMA.parse().unwrap();
        assert_eq!(serde_json::to_string(&parsed).unwrap(), SCHEMA);
        assert_eq!(parsed.to_string(), SCHEMA);
        // Negative control: the type this replaces does not keep it.
        let value: Value = serde_json::from_str(SCHEMA).unwrap();
        assert_ne!(serde_json::to_string(&value).unwrap(), SCHEMA);
    }

    #[test]
    fn sorted_keys_serialize_exactly_like_a_value() {
        for text in [
            SCHEMA,
            r#"{"z":[{"y":1,"b":-2,"a":1.5e3}],"é":null,"E":true,"x":1,"x":"last","":{}}"#,
            r#"[3,{"b":18446744073709551615,"a":-9223372036854775808}]"#,
            r#""\u0000\"\\""#,
        ] {
            let ordered: OrderedJson = text.parse().unwrap();
            let value: Value = serde_json::from_str(text).unwrap();
            assert_eq!(
                serde_json::to_vec(&ordered.with_sorted_keys()).unwrap(),
                serde_json::to_vec(&value).unwrap(),
                "{text}"
            );
            assert_eq!(ordered.to_value(), value, "{text}");
        }
    }

    #[test]
    fn a_repeated_name_keeps_its_first_position_and_last_value() {
        let parsed: OrderedJson = r#"{"b":1,"a":2,"b":3}"#.parse().unwrap();
        assert_eq!(parsed.to_string(), r#"{"b":3,"a":2}"#);
        let built = OrderedJson::object([("b", true.into()), ("a", "x".into()), ("b", "y".into())]);
        assert_eq!(built.to_string(), r#"{"b":"y","a":"x"}"#);
    }

    #[test]
    fn equality_is_order_sensitive_and_value_conversion_is_not() {
        let ab: OrderedJson = r#"{"a":1,"b":2}"#.parse().unwrap();
        let ba: OrderedJson = r#"{"b":2,"a":1}"#.parse().unwrap();
        assert_ne!(ab, ba);
        assert_eq!(ab.to_value(), ba.to_value());
        assert_eq!(ab.with_sorted_keys(), ba.with_sorted_keys());
        assert_eq!(
            OrderedJson::from(json!({"b": 2, "a": 1})).to_value(),
            ab.to_value()
        );
    }

    #[test]
    fn decodes_through_a_buffering_deserializer_in_order() {
        // An internally tagged enum buffers its content before decoding the
        // variant; order must survive that too (`ResponseFormat` is one).
        #[derive(serde::Deserialize)]
        #[serde(tag = "type")]
        enum Tagged {
            S { s: OrderedJson },
        }
        let Tagged::S { s } =
            serde_json::from_str(&alloc::format!(r#"{{"type":"S","s":{SCHEMA}}}"#)).unwrap();
        assert_eq!(s.to_string(), SCHEMA);
    }

    /// serde_json's `arbitrary_precision` and `raw_value` map forms: decoded
    /// exactly as `Value` decodes them. Without the features the private keys
    /// are ordinary members; with them (CI runs these tests with each:
    /// `--features serde_json/arbitrary_precision`, `serde_json/raw_value`)
    /// fractional numbers stay numbers and a raw member decodes its text.
    #[test]
    fn private_serde_json_forms_decode_as_value_does() {
        for text in [
            r#"{"type":"number","minimum":0.5,"enum":[1.25e3,-0.0,7]}"#,
            r#"{"$serde_json::private::Number":"0.5"}"#,
            r#"{"default":{"$serde_json::private::RawValue":"{\"b\":1,\"a\":[2]}"},"x":1}"#,
        ] {
            let ordered: OrderedJson = text.parse().unwrap();
            let value: Value = serde_json::from_str(text).unwrap();
            assert_eq!(ordered.to_value(), value, "{text}");
            assert_eq!(
                serde_json::to_vec(&ordered.with_sorted_keys()).unwrap(),
                serde_json::to_vec(&value).unwrap(),
                "{text}"
            );
        }
        let schema: OrderedJson = r#"{"minimum":0.5}"#.parse().unwrap();
        assert_eq!(schema.to_string(), r#"{"minimum":0.5}"#);
    }

    /// Decoding from a `Value` (`serde_json::from_value`, the Tauri plugin's
    /// IPC path) agrees with `Value` too. Under `arbitrary_precision` a
    /// `Value` hands integers wider than 64 bits to `visit_u128`/`visit_i128`
    /// and a non-`f64` decimal to the private map form; without it they are
    /// already `f64`s.
    #[test]
    fn decoding_from_a_value_agrees_with_value() {
        for text in [
            SCHEMA,
            r#"{"maximum":18446744073709551616,"minimum":-9223372036854775809}"#,
            r#"{"big":340282366920938463463374607431768211456,"exact":0.1000000000000000000001}"#,
            r#"[18446744073709551615,-9223372036854775808,1.5,1e2]"#,
        ] {
            let value: Value = serde_json::from_str(text).unwrap();
            let ordered: OrderedJson = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(ordered.to_value(), value, "{text}");
            assert_eq!(
                serde_json::to_vec(&ordered.with_sorted_keys()).unwrap(),
                serde_json::to_vec(&value).unwrap(),
                "{text}"
            );
        }
    }

    #[test]
    fn builders_and_predicates() {
        assert!(OrderedJson::object::<&str>([]).is_object());
        assert!(!OrderedJson::array([]).is_object());
        assert_eq!(OrderedJson::NULL.to_string(), "null");
        assert_eq!(
            OrderedJson::array([OrderedJson::from("x"), String::from("y").into()]).to_string(),
            r#"["x","y"]"#
        );
        assert!("{".parse::<OrderedJson>().is_err());
    }
}
