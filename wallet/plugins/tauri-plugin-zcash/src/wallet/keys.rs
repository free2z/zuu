use bip0039::{Count, Mnemonic};
use secrecy::SecretVec;
use zcash_keys::keys::UnifiedSpendingKey;
use zcash_protocol::consensus::Network;

use base64::Engine;
use ripemd::Ripemd160;
use secp256k1::{Message, PublicKey, Scalar, Secp256k1, SecretKey};
use sha2::{Digest, Sha256, Sha512};

use crate::error::{Error, Result};

/// Generate a new BIP39 mnemonic seed phrase.
pub fn generate_mnemonic(word_count: u32) -> Result<Mnemonic> {
    let count = match word_count {
        12 => Count::Words12,
        15 => Count::Words15,
        18 => Count::Words18,
        21 => Count::Words21,
        24 => Count::Words24,
        _ => return Err(Error::InvalidMnemonic(
            format!("unsupported word count: {word_count}; use 12, 15, 18, 21, or 24"),
        )),
    };
    Ok(Mnemonic::generate(count))
}

/// Parse an existing mnemonic phrase.
pub fn parse_mnemonic(phrase: &str) -> Result<Mnemonic> {
    Mnemonic::from_phrase(phrase)
        .map_err(|e| Error::InvalidMnemonic(e.to_string()))
}

/// Derive a seed from a mnemonic.
pub fn mnemonic_to_seed(mnemonic: &Mnemonic) -> SecretVec<u8> {
    let seed_bytes = mnemonic.to_seed("");
    SecretVec::new(seed_bytes.to_vec())
}

/// Derive a unified spending key for a given account index.
pub fn derive_usk(
    seed: &[u8],
    network: &Network,
    account_index: u32,
) -> Result<UnifiedSpendingKey> {
    let account = zip32::AccountId::try_from(account_index)
        .map_err(|e| Error::KeyError(format!("invalid account index: {e}")))?;
    UnifiedSpendingKey::from_seed(network, seed, account)
        .map_err(|e| Error::KeyError(format!("key derivation failed: {e}")))
}

/// A server-verifiable "ZUULI Zcash Login v1" signature over a login challenge.
///
/// - `address`  — the mainnet transparent P2PKH t-address (base58check) whose
///   key produced the signature.
/// - `signature` — base64 of the 65-byte recoverable ECDSA signature.
/// - `pubkey`   — hex of the 33-byte compressed secp256k1 public key.
pub struct ChallengeSignature {
    pub address: String,
    pub signature: String,
    pub pubkey: String,
}

/// Sign a "Login with Zcash" challenge with a **real, server-verifiable Zcash
/// transparent-address message signature** — the "ZUULI Zcash Login v1" scheme.
///
/// This produces exactly what `zcashd signmessage(<t-addr>, <challenge>)` emits,
/// so the backend can verify it with `zcashd verifymessage(address, signature,
/// challenge)`. (Supersedes the earlier interim `zuuli-hmac-v1` HMAC binding,
/// which was a symmetric MAC and not verifiable by a standard Zcash node.)
///
/// Scheme, matching zcashd/Bitcoin `signmessage`/`verifymessage`:
/// 1. **Key** — derive the account's transparent P2PKH key from the wallet seed
///    via BIP44 `m/44'/133'/{account}'/0/0` (mainnet Zcash coin type = 133;
///    purpose/coin/account are hardened, the change/index levels are not).
///    BIP32 CKD is done directly over `secp256k1` + HMAC-SHA512.
/// 2. **Address** — mainnet transparent P2PKH t-address =
///    `base58check([0x1C, 0xB8] ++ HASH160(compressed_pubkey))`, where
///    `HASH160 = RIPEMD160(SHA256(pubkey))`.
/// 3. **Digest** — Bitcoin/Zcash message-signing convention:
///    `magic = "Zcash Signed Message:\n"`;
///    `data = CompactSize(len(magic)) ++ magic ++ CompactSize(len(challenge)) ++ challenge`;
///    `digest = SHA256(SHA256(data))`.
/// 4. **Signature** — recoverable ECDSA over `digest`, serialized as the 65-byte
///    form `header ++ r(32) ++ s(32)` with `header = 27 + recovery_id + 4`
///    (the `+4` marks a compressed pubkey, so `header ∈ 31..=34`), then base64
///    (standard, padded). This is the exact form `verifymessage` accepts.
pub fn sign_challenge(
    seed: &[u8],
    account_index: u32,
    challenge: &str,
) -> Result<ChallengeSignature> {
    let secp = Secp256k1::new();

    // BIP44 m/44'/133'/{account}'/0/0
    let signing_key = derive_transparent_p2pkh_key(&secp, seed, account_index)?;
    let pubkey = PublicKey::from_secret_key(&secp, &signing_key);
    let pubkey_compressed = pubkey.serialize(); // 33-byte compressed

    let address = p2pkh_address(&pubkey_compressed);

    let digest = message_digest(challenge);
    let msg = Message::from_digest(digest);
    let recoverable = secp.sign_ecdsa_recoverable(&msg, &signing_key);
    let (recovery_id, compact) = recoverable.serialize_compact();

    // header = 27 + recovery_id + 4 (compressed pubkey) => 31..=34
    let header = 27u8 + recovery_id.to_i32() as u8 + 4;
    let mut sig65 = Vec::with_capacity(65);
    sig65.push(header);
    sig65.extend_from_slice(&compact);

    let signature = base64::engine::general_purpose::STANDARD.encode(&sig65);

    Ok(ChallengeSignature {
        address,
        signature,
        pubkey: hex_encode(&pubkey_compressed),
    })
}

/// A BIP32 extended private key node: the secp256k1 secret plus its chain code.
struct ExtendedKey {
    secret: SecretKey,
    chain_code: [u8; 32],
}

/// Derive the transparent P2PKH signing key at BIP44 `m/44'/133'/{account}'/0/0`.
fn derive_transparent_p2pkh_key(
    secp: &Secp256k1<secp256k1::All>,
    seed: &[u8],
    account_index: u32,
) -> Result<SecretKey> {
    let master = master_key(seed)?;
    let purpose = derive_child(secp, &master, 44, true)?;
    let coin = derive_child(secp, &purpose, 133, true)?;
    let account = derive_child(secp, &coin, account_index, true)?;
    let change = derive_child(secp, &account, 0, false)?;
    let external = derive_child(secp, &change, 0, false)?;
    Ok(external.secret)
}

/// BIP32 master key from a seed: `HMAC-SHA512("Bitcoin seed", seed)`.
fn master_key(seed: &[u8]) -> Result<ExtendedKey> {
    let i = hmac_sha512(b"Bitcoin seed", seed);
    let secret = SecretKey::from_slice(&i[..32])
        .map_err(|e| Error::KeyError(format!("invalid master key: {e}")))?;
    let mut chain_code = [0u8; 32];
    chain_code.copy_from_slice(&i[32..]);
    Ok(ExtendedKey { secret, chain_code })
}

/// BIP32 private-parent → private-child derivation (CKDpriv).
fn derive_child(
    secp: &Secp256k1<secp256k1::All>,
    parent: &ExtendedKey,
    index: u32,
    hardened: bool,
) -> Result<ExtendedKey> {
    let mut data = Vec::with_capacity(37);
    if hardened {
        // 0x00 || ser256(k_par)
        data.push(0x00);
        data.extend_from_slice(&parent.secret.secret_bytes());
    } else {
        // serP(point(k_par)) — compressed public key
        let pk = PublicKey::from_secret_key(secp, &parent.secret);
        data.extend_from_slice(&pk.serialize());
    }
    let child_number = if hardened { index | 0x8000_0000 } else { index };
    data.extend_from_slice(&child_number.to_be_bytes());

    let i = hmac_sha512(&parent.chain_code, &data);

    let mut il = [0u8; 32];
    il.copy_from_slice(&i[..32]);
    let tweak = Scalar::from_be_bytes(il)
        .map_err(|e| Error::KeyError(format!("invalid child key tweak: {e}")))?;
    // child_key = (parse256(I_L) + k_par) mod n
    let secret = parent
        .secret
        .add_tweak(&tweak)
        .map_err(|e| Error::KeyError(format!("child key derivation failed: {e}")))?;

    let mut chain_code = [0u8; 32];
    chain_code.copy_from_slice(&i[32..]);
    Ok(ExtendedKey { secret, chain_code })
}

/// Mainnet transparent P2PKH t-address:
/// `base58check([0x1C, 0xB8] ++ HASH160(compressed_pubkey))`.
fn p2pkh_address(pubkey_compressed: &[u8]) -> String {
    let pkh = hash160(pubkey_compressed);
    let mut payload = Vec::with_capacity(2 + pkh.len());
    payload.extend_from_slice(&[0x1C, 0xB8]);
    payload.extend_from_slice(&pkh);
    bs58::encode(payload).with_check().into_string()
}

/// `HASH160(x) = RIPEMD160(SHA256(x))`.
fn hash160(data: &[u8]) -> [u8; 20] {
    let sha = Sha256::digest(data);
    let ripe = Ripemd160::digest(sha);
    let mut out = [0u8; 20];
    out.copy_from_slice(&ripe);
    out
}

/// The double-SHA256 digest over the length-prefixed, magic-framed message that
/// zcashd/Bitcoin `signmessage` signs.
fn message_digest(challenge: &str) -> [u8; 32] {
    const MAGIC: &[u8] = b"Zcash Signed Message:\n";
    let challenge = challenge.as_bytes();

    let mut data = Vec::with_capacity(MAGIC.len() + challenge.len() + 18);
    write_compact_size(&mut data, MAGIC.len() as u64);
    data.extend_from_slice(MAGIC);
    write_compact_size(&mut data, challenge.len() as u64);
    data.extend_from_slice(challenge);

    let first = Sha256::digest(&data);
    let second = Sha256::digest(first);
    let mut out = [0u8; 32];
    out.copy_from_slice(&second);
    out
}

/// Bitcoin CompactSize (varint) encoding.
fn write_compact_size(out: &mut Vec<u8>, n: u64) {
    if n < 0xFD {
        out.push(n as u8);
    } else if n <= 0xFFFF {
        out.push(0xFD);
        out.extend_from_slice(&(n as u16).to_le_bytes());
    } else if n <= 0xFFFF_FFFF {
        out.push(0xFE);
        out.extend_from_slice(&(n as u32).to_le_bytes());
    } else {
        out.push(0xFF);
        out.extend_from_slice(&n.to_le_bytes());
    }
}

/// Minimal HMAC-SHA512 (RFC 2104) on the `sha2` crate — used for BIP32 CKD.
fn hmac_sha512(key: &[u8], message: &[u8]) -> [u8; 64] {
    const BLOCK: usize = 128;

    let mut block_key = [0u8; BLOCK];
    if key.len() > BLOCK {
        let hashed = Sha512::digest(key);
        block_key[..hashed.len()].copy_from_slice(&hashed);
    } else {
        block_key[..key.len()].copy_from_slice(key);
    }

    let mut ipad = [0x36u8; BLOCK];
    let mut opad = [0x5cu8; BLOCK];
    for i in 0..BLOCK {
        ipad[i] ^= block_key[i];
        opad[i] ^= block_key[i];
    }

    let inner = {
        let mut h = Sha512::new();
        h.update(ipad);
        h.update(message);
        h.finalize()
    };

    let outer = {
        let mut h = Sha512::new();
        h.update(opad);
        h.update(inner);
        h.finalize()
    };

    let mut out = [0u8; 64];
    out.copy_from_slice(&outer);
    out
}

fn hex_encode(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use secp256k1::ecdsa::{RecoverableSignature, RecoveryId};

    /// Sign a fixed challenge with a fixed seed, then INDEPENDENTLY recover the
    /// signing pubkey from the recoverable signature + reconstructed digest and
    /// assert it matches the derived pubkey, and that HASH160(pubkey) matches the
    /// pubkey-hash embedded in the produced t-address. This proves the digest
    /// construction, recovery id, and address are internally consistent — the
    /// same relationships zcashd `verifymessage` checks — without a live node.
    #[test]
    fn sign_challenge_recovers_pubkey_and_address() {
        // Fixed 64-byte test seed (arbitrary; BIP32 treats the seed as entropy).
        let seed: [u8; 64] = [
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
            0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c,
            0x1d, 0x1e, 0x1f, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a,
            0x2b, 0x2c, 0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38,
            0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x40,
        ];
        let challenge = "ZUULI login challenge: 2026-07-18T00:00:00Z nonce=deadbeef";

        let signed = sign_challenge(&seed, 0, challenge).expect("signing must succeed");

        // Mainnet t-addr must start with "t1".
        assert!(
            signed.address.starts_with("t1"),
            "expected mainnet P2PKH t1 address, got {}",
            signed.address
        );

        // Decode the base64 signature back to the 65-byte header||r||s form.
        let sig65 = base64::engine::general_purpose::STANDARD
            .decode(signed.signature.as_bytes())
            .expect("signature must be valid base64");
        assert_eq!(sig65.len(), 65, "signature must be 65 bytes");

        let header = sig65[0];
        // Compressed-pubkey header lives in 31..=34 (27 + recid + 4).
        assert!(
            (31..=34).contains(&header),
            "header {header} out of compressed range 31..=34"
        );
        let recovery_id = RecoveryId::from_i32(((header - 27) & 0x03) as i32)
            .expect("valid recovery id");
        let compressed_flag = (header - 27) & 0x04 != 0;
        assert!(compressed_flag, "header must mark a compressed pubkey");

        // Independently reconstruct the signed digest and recover the pubkey.
        let digest = message_digest(challenge);
        let msg = Message::from_digest(digest);
        let recoverable = RecoverableSignature::from_compact(&sig65[1..65], recovery_id)
            .expect("valid recoverable signature");

        let secp = Secp256k1::new();
        let recovered = secp
            .recover_ecdsa(&msg, &recoverable)
            .expect("pubkey recovery must succeed");
        let recovered_compressed = recovered.serialize();

        // 1) Recovered pubkey == derived signing pubkey (from the returned hex).
        assert_eq!(
            hex_encode(&recovered_compressed),
            signed.pubkey,
            "recovered pubkey must equal the derived signing pubkey"
        );

        // 2) HASH160(recovered pubkey) == pubkey-hash embedded in the t-address.
        let decoded = bs58::decode(&signed.address)
            .with_check(None)
            .into_vec()
            .expect("t-address must be valid base58check");
        assert_eq!(&decoded[..2], &[0x1C, 0xB8], "mainnet P2PKH prefix");
        assert_eq!(
            &decoded[2..],
            &hash160(&recovered_compressed),
            "address pubkey-hash must equal HASH160(recovered pubkey)"
        );

        // Determinism: signing again yields the identical signature.
        let again = sign_challenge(&seed, 0, challenge).expect("signing must succeed");
        assert_eq!(again.signature, signed.signature, "signing must be deterministic");
        assert_eq!(again.address, signed.address);
        assert_eq!(again.pubkey, signed.pubkey);
    }
}
