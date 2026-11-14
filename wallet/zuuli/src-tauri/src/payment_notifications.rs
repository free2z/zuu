//! Receive-only observation of the wallet's existing authorized sync.
//! No key access, unlock, remote oracle, or new sync task. History never leaves this process.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{Listener, Manager, Runtime};
use tauri_plugin_zcash::ZcashExt;

#[derive(Default)]
struct Observation {
    wallet: Option<String>,
    height: u64,
}
impl Observation {
    fn advance(
        &mut self,
        wallet: String,
        height: u64,
        incoming_heights: impl Iterator<Item = u64>,
    ) -> (bool, bool) {
        let changed = self.wallet.as_ref().is_some_and(|v| v != &wallet);
        let notice = self.wallet.as_ref() == Some(&wallet)
            && height >= self.height
            && incoming_heights
                .take(500)
                .any(|h| h > self.height && h <= height);
        self.wallet = Some(wallet);
        // A reorg never lowers the watermark; historical imports/reorg rediscovery do not alert.
        self.height = if changed {
            height
        } else {
            self.height.max(height)
        };
        (changed, notice)
    }
}
/// Events are only scheduling hints. A forged renderer event cannot fabricate a DB payment.
pub fn install<R: Runtime>(app: &tauri::AppHandle<R>) {
    app.manage(tauri_plugin_zcash::WalletDisconnectHook::<R>(Box::new(
        |handle| {
            Box::pin(async move {
                tauri_plugin_notify::disconnect(&handle)
                    .await
                    .map_err(str::to_owned)
            })
        },
    )));
    let app = app.clone();
    let busy = Arc::new(AtomicBool::new(false));
    let observation = Arc::new(tokio::sync::Mutex::new(Observation::default()));
    let handle = app.clone();
    app.listen("zcash://sync-progress", move |_| {
        if busy.swap(true, Ordering::AcqRel) {
            return;
        }
        let app = handle.clone();
        let busy = busy.clone();
        let observation = observation.clone();
        tauri::async_runtime::spawn(async move {
            observe(&app, &observation).await;
            busy.store(false, Ordering::Release);
        });
    });
}
async fn observe<R: Runtime>(
    app: &tauri::AppHandle<R>,
    observation: &tokio::sync::Mutex<Observation>,
) {
    // Observe only the sync the wallet already authorized. This does not start
    // or resume it, and does not rely on desktop-only window focus semantics.
    let state = &app.zcash().state;
    let _transition = state.lock_wallet_transition().await;
    let Some(wallet) = state.active_wallet_id().await else {
        let _ = tauri_plugin_notify::disconnect(app).await;
        *observation.lock().await = Observation::default();
        return;
    };
    let Ok(sync) = tauri_plugin_zcash::wallet::sync::get_sync_status(state).await else {
        return;
    };
    if sync.last_error.is_some() || sync.chain_tip == 0 || sync.synced_height < sync.chain_tip {
        return;
    }
    let Ok(history) =
        tauri_plugin_zcash::wallet::history::get_transaction_history(state, 0, 0, 500).await
    else {
        return;
    };
    let (changed, notice) = observation.lock().await.advance(
        wallet,
        sync.synced_height,
        history
            .iter()
            .filter(|t| t.incoming)
            .filter_map(|t| t.block_height),
    );
    if changed {
        let _ = tauri_plugin_notify::disconnect(app).await;
    } else if notice {
        let _ = tauri_plugin_notify::payment_verified(app);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_new_mined_incoming_after_baseline_can_request_a_generic_local_notice() {
        let mut o = Observation::default();
        assert_eq!(
            o.advance("a".into(), 100, [90, 100].into_iter()),
            (false, false)
        );
        assert_eq!(o.advance("a".into(), 101, [101].into_iter()), (false, true));
        assert_eq!(
            o.advance("a".into(), 101, [101].into_iter()),
            (false, false)
        );
        assert_eq!(o.advance("a".into(), 99, [99].into_iter()), (false, false));
        assert_eq!(
            o.advance("a".into(), 101, [101].into_iter()),
            (false, false)
        );
        assert_eq!(o.advance("b".into(), 200, [200].into_iter()), (true, false));
    }
}
