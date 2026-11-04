use anyhow::{Result, bail, ensure};
use serde::Deserialize;
use std::{
    fs,
    path::{Path, PathBuf},
};
use zcash_protocol::consensus::{Network, NetworkUpgrade, Parameters};

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Consumer {
    pub id: String,
    /// Absolute executable plus literal arguments; never interpreted by a shell.
    pub argv: Vec<String>,
    pub timeout_seconds: u64,
    /// Explicit opt-in: observed notes must only capture evidence, never issue credit.
    #[serde(default)]
    pub observe_unconfirmed: bool,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub network: String,
    pub rpc_url: String,
    pub rpc_cookie_file: Option<PathBuf>,
    pub ufvk_file: PathBuf,
    pub state_dir: PathBuf,
    pub birthday_height: u32,
    /// Explicit inclusive floor. Historic scanning below it never executes hooks.
    pub automation_start_height: u32,
    pub confirmations: u32,
    pub poll_seconds: u64,
    pub max_tip_age_seconds: u64,
    pub max_tip_lag_blocks: u32,
    /// Node-validated tips may legitimately be ahead of this machine's clock.
    pub max_tip_future_seconds: u64,
    #[serde(default)]
    pub consumers: Vec<Consumer>,
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let c: Self = toml::from_str(&fs::read_to_string(path)?)?;
        c.validate()?;
        Ok(c)
    }
    pub fn params(&self) -> Result<Network> {
        match self.network.as_str() {
            "main" => Ok(Network::MainNetwork),
            "test" => Ok(Network::TestNetwork),
            _ => bail!("network must be main or test"),
        }
    }
    pub fn validate(&self) -> Result<()> {
        let params = self.params()?;
        ensure!(
            self.birthday_height
                >= u32::from(params.activation_height(NetworkUpgrade::Sapling).unwrap()),
            "birthday must be at or after Sapling; Sprout is unsupported"
        );
        ensure!(
            self.automation_start_height >= self.birthday_height,
            "automation floor precedes birthday"
        );
        ensure!(
            self.confirmations > 0 && self.poll_seconds > 0,
            "confirmations and polling must be positive"
        );
        ensure!(
            self.max_tip_age_seconds > 0 && self.max_tip_age_seconds <= 86400,
            "tip age limit must be 1..86400 seconds"
        );
        ensure!(
            self.poll_seconds <= 3600 && self.confirmations <= 100000,
            "polling/confirmation limit exceeds supported bound"
        );
        ensure!(
            self.ufvk_file.is_absolute()
                && self.state_dir.is_absolute()
                && self
                    .rpc_cookie_file
                    .as_ref()
                    .is_none_or(|p| p.is_absolute()),
            "state and secret paths must be absolute"
        );
        ensure!(
            self.max_tip_future_seconds <= 86400,
            "future tip limit exceeds one day"
        );
        let url = reqwest::Url::parse(&self.rpc_url)?;
        ensure!(
            url.username().is_empty() && url.password().is_none(),
            "put RPC credentials in a private cookie file"
        );
        ensure!(
            url.scheme() == "https"
                || (url.scheme() == "http"
                    && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))),
            "RPC must use loopback HTTP or HTTPS"
        );
        let mut ids = std::collections::HashSet::new();
        for c in &self.consumers {
            ensure!(
                !c.id.is_empty() && ids.insert(&c.id),
                "consumer ids must be nonempty and unique"
            );
            ensure!(
                !c.argv.is_empty() && Path::new(&c.argv[0]).is_absolute(),
                "consumer executable must be absolute"
            );
            ensure!(
                c.timeout_seconds > 0 && c.timeout_seconds <= 3600,
                "consumer timeout must be 1..3600 seconds"
            );
        }
        Ok(())
    }
}

#[cfg(unix)]
pub fn private_file(path: &Path) -> Result<String> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let m = fs::symlink_metadata(path)?;
    ensure!(
        m.is_file() && !m.file_type().is_symlink(),
        "secret must be a regular non-symlink file"
    );
    ensure!(
        m.uid() == unsafe { libc::geteuid() } && m.permissions().mode() & 0o077 == 0,
        "secret file must be owned by daemon user and inaccessible to group/others"
    );
    Ok(fs::read_to_string(path)?.trim().to_owned())
}
