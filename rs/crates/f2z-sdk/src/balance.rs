//! `GET /api/sdk/v1/balance` (`docs/sdk/spec/purchase.md` §1.1).

use f2z_ai_proto::balance::Balance;

use crate::client::Client;
use crate::error::Error;
use crate::http;

impl Client {
    /// The user's 2Z balance — the authority, unlike the `balance_hint` a
    /// chat `done` carries. Needs `balance:read`.
    ///
    /// Show `available_milli_2z`; show a non-zero `debt_milli_2z` as its own
    /// line ([`Balance::in_debt`]).
    ///
    /// # Errors
    ///
    /// [`Error::Api`] with the envelope (`403 insufficient_scope`, …);
    /// [`Error::SignedOut`] when there is no session.
    pub async fn balance(&self) -> Result<Balance, Error> {
        let url = format!("{}/balance", self.inner.config.api_base);
        let timeout = self.inner.config.request_timeout;
        let response = self
            .send_authorized(|http, token| http.get(&url).bearer_auth(token).timeout(timeout))
            .await?;
        let response = http::expect_success(response).await?;
        http::read_json(response).await
    }
}
