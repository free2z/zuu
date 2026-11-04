use crate::{
    Payment,
    config::{Config, private_file},
};
use anyhow::{Result, ensure};
use async_trait::async_trait;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, io::Cursor, path::PathBuf};
use zcash_client_backend::{TransferType, decrypt_transaction};
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_primitives::block::Block;
use zcash_protocol::consensus::{BlockHeight, BranchId, Network};

#[derive(Clone, Debug)]
pub struct ObservedBlock {
    pub height: u32,
    pub hash: String,
    pub previous_hash: String,
    pub payments: Vec<Payment>,
}

#[derive(Clone, Debug)]
pub struct ChainTip {
    pub height: u32,
    pub timestamp: i64,
}

#[async_trait]
pub trait Chain: Send + Sync {
    async fn tip(&self) -> Result<ChainTip>;
    async fn hash(&self, height: u32) -> Result<String>;
    async fn block(&self, height: u32, hash: &str) -> Result<ObservedBlock>;
}

pub struct Zakura {
    client: reqwest::Client,
    url: String,
    cookie: Option<PathBuf>,
    params: Network,
    max_tip_age_seconds: u64,
    max_tip_lag_blocks: u32,
    max_tip_future_seconds: u64,
    network: String,
    keys: HashMap<u32, UnifiedFullViewingKey>,
}
impl Zakura {
    pub fn new(c: &Config, ufvk: &str) -> Result<Self> {
        let params = c.params()?;
        let key = UnifiedFullViewingKey::decode(&params, ufvk)
            .map_err(|_| anyhow::anyhow!("invalid UFVK for configured network"))?;
        ensure!(
            key.sapling().is_some() || key.orchard().is_some(),
            "UFVK must contain a supported shielded receiver"
        );
        Ok(Self {
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(30))
                .build()?,
            url: c.rpc_url.clone(),
            cookie: c.rpc_cookie_file.clone(),
            params,
            max_tip_age_seconds: c.max_tip_age_seconds,
            max_tip_lag_blocks: c.max_tip_lag_blocks,
            max_tip_future_seconds: c.max_tip_future_seconds,
            network: c.network.clone(),
            keys: HashMap::from([(0, key)]),
        })
    }
    async fn rpc(&self, method: &str, params: Value) -> Result<Value> {
        let mut request = self
            .client
            .post(&self.url)
            .json(&json!({"jsonrpc":"2.0","id":"paymentd","method":method,"params":params}));
        if let Some(path) = &self.cookie {
            let cookie = private_file(path)?;
            let (user, pass) = cookie
                .split_once(':')
                .ok_or_else(|| anyhow::anyhow!("invalid RPC cookie"))?;
            request = request.basic_auth(user, Some(pass));
        }
        let mut response = request.send().await?.error_for_status()?;
        // Blocks are bounded by consensus; allow hexadecimal and JSON framing.
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            ensure!(
                bytes.len() + chunk.len() <= 16 * 1024 * 1024,
                "RPC response exceeded size limit"
            );
            bytes.extend_from_slice(&chunk);
        }
        let body: Value = serde_json::from_slice(&bytes)?;
        ensure!(
            body.get("error").is_none_or(Value::is_null),
            "RPC {method} failed; check node retention, sync and method support"
        );
        body.get("result")
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("RPC omitted result"))
    }
}
#[async_trait]
impl Chain for Zakura {
    async fn tip(&self) -> Result<ChainTip> {
        let info = self.rpc("getblockchaininfo", json!([])).await?;
        ensure!(
            info["chain"].as_str() == Some(self.network.as_str()),
            "node network differs from configured wallet"
        );
        let h = info["blocks"]
            .as_u64()
            .ok_or_else(|| anyhow::anyhow!("node omitted chain tip"))?;
        ensure!(
            info["initialblockdownload"].as_bool() != Some(true),
            "node is in initial synchronization"
        );
        let estimated = info["estimatedheight"].as_u64().ok_or_else(|| {
            anyhow::anyhow!("node omitted estimated height; freshness cannot be established")
        })?;
        // Released Zakura reports known headers separately from its timestamp-
        // based estimate. A future-dated loaded tip must not hide missing bodies.
        let headers = info["headers"].as_u64().ok_or_else(|| {
            anyhow::anyhow!("node omitted known header height; freshness cannot be established")
        })?;
        ensure!(
            estimated.max(headers).saturating_sub(h) <= u64::from(self.max_tip_lag_blocks),
            "node chain tip is behind known headers or estimated network height"
        );
        let expected_hash = self.hash(u32::try_from(h)?).await?;
        let header = self
            .rpc("getblockheader", json!([expected_hash, true]))
            .await?;
        ensure!(
            header["hash"].as_str() == Some(expected_hash.as_str())
                && header["height"].as_u64() == Some(h),
            "node returned a different tip header"
        );
        let expected_branch = format!(
            "{:08x}",
            u32::from(BranchId::for_height(
                &self.params,
                BlockHeight::from(u32::try_from(h)?)
            ))
        );
        ensure!(
            info["consensus"]["chaintip"].as_str() == Some(expected_branch.as_str()),
            "node consensus upgrade is unsupported by observer libraries"
        );
        let time = header["time"]
            .as_i64()
            .ok_or_else(|| anyhow::anyhow!("node omitted tip time"))?;
        ensure!(
            time <= crate::now() + self.max_tip_future_seconds as i64
                && crate::now().saturating_sub(time) <= self.max_tip_age_seconds as i64,
            "node chain tip timestamp is stale or in the future"
        );
        Ok(ChainTip {
            height: u32::try_from(h)?,
            timestamp: time,
        })
    }
    async fn hash(&self, height: u32) -> Result<String> {
        let v = self.rpc("getblockhash", json!([height])).await?;
        let h = v
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("invalid block hash"))?;
        ensure!(
            h.len() == 64 && hex::decode(h).is_ok(),
            "invalid block hash"
        );
        Ok(h.to_owned())
    }
    async fn block(&self, height: u32, hash: &str) -> Result<ObservedBlock> {
        let v = self.rpc("getblock", json!([hash, 0])).await?;
        let raw = hex::decode(
            v.as_str()
                .ok_or_else(|| anyhow::anyhow!("node did not return a raw block"))?,
        )?;
        decrypt_block(&self.params, &self.network, &self.keys, height, hash, &raw)
    }
}

pub fn decrypt_block(
    params: &Network,
    network: &str,
    keys: &HashMap<u32, UnifiedFullViewingKey>,
    height: u32,
    expected_hash: &str,
    raw: &[u8],
) -> Result<ObservedBlock> {
    let mut reader = Cursor::new(raw);
    let block = Block::read(&mut reader, params)?;
    ensure!(
        reader.position() == raw.len() as u64,
        "trailing bytes in raw block"
    );
    ensure!(
        block.header().hash().to_string() == expected_hash,
        "raw block hash mismatch"
    );
    ensure!(
        u32::from(block.claimed_height()) == height,
        "raw block height mismatch"
    );
    ensure!(
        merkle_root(block.vtx().iter().map(|tx| *tx.txid().as_ref()).collect())
            == block.header().merkle_root,
        "transaction Merkle root does not match block header"
    );
    let mut payments = Vec::new();
    for tx in block.vtx().iter() {
        ensure!(
            tx.consensus_branch_id() == BranchId::for_height(params, BlockHeight::from(height)),
            "unsupported or inconsistent network-upgrade branch; update observer libraries before scanning"
        );
        let decoded = decrypt_transaction(params, Some(BlockHeight::from(height)), None, tx, keys);
        let txid = tx.txid().to_string();
        for o in decoded.sapling_outputs() {
            if o.transfer_type() == TransferType::Incoming {
                payments.push(payment(
                    network,
                    &txid,
                    "sapling",
                    o.index(),
                    o.note_value().into_u64(),
                    o.memo().as_array(),
                    &o.note().recipient().to_bytes(),
                ));
            }
        }
        for (pool, outputs) in [
            ("orchard", decoded.orchard_outputs()),
            ("ironwood", decoded.ironwood_outputs()),
        ] {
            for o in outputs {
                if o.transfer_type() == TransferType::Incoming {
                    payments.push(payment(
                        network,
                        &txid,
                        pool,
                        o.index(),
                        o.note().0.value().inner(),
                        o.memo().as_array(),
                        &o.note().0.recipient().to_raw_address_bytes(),
                    ));
                }
            }
        }
    }
    Ok(ObservedBlock {
        height,
        hash: expected_hash.to_owned(),
        previous_hash: block.header().prev_block.to_string(),
        payments,
    })
}
fn payment(
    network: &str,
    txid: &str,
    pool: &str,
    output_index: usize,
    value_zatoshis: u64,
    memo: &[u8; 512],
    recipient: &[u8; 43],
) -> Payment {
    Payment {
        id: format!("{network}:{txid}:{pool}:{output_index}"),
        txid: txid.to_owned(),
        pool: pool.to_owned(),
        output_index,
        value_zatoshis,
        memo_hex: hex::encode(memo),
        recipient_hex: hex::encode(recipient),
    }
}

/// Bitcoin/Zcash transaction Merkle tree, with duplicate-last-node padding.
pub fn merkle_root(mut nodes: Vec<[u8; 32]>) -> [u8; 32] {
    assert!(!nodes.is_empty());
    while nodes.len() > 1 {
        if nodes.len() % 2 == 1 {
            nodes.push(*nodes.last().unwrap());
        }
        nodes = nodes
            .chunks_exact(2)
            .map(|p| {
                let mut h = Sha256::new();
                h.update(p[0]);
                h.update(p[1]);
                Sha256::digest(h.finalize()).into()
            })
            .collect();
    }
    nodes[0]
}
