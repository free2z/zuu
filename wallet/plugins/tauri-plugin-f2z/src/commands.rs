use crate::{
    PluginState,
    wire::{self, NativeError, Result},
};
use serde_json::{Value, json};
use std::sync::Arc;
use tauri::{Runtime, State, Webview};

fn authorized<R: Runtime>(webview: &Webview<R>, state: &PluginState<R>) -> Result<()> {
    if state
        .windows
        .iter()
        .any(|label| label == webview.window().label())
    {
        Ok(())
    } else {
        Err(NativeError::new("window_not_allowed"))
    }
}
#[tauri::command]
pub async fn session<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, Arc<PluginState<R>>>,
) -> Result<Value> {
    authorized(&webview, &state)?;
    state.engine.session().await
}
#[tauri::command]
pub async fn sign_in<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, Arc<PluginState<R>>>,
    options: wire::SignInOptions,
) -> Result<Value> {
    authorized(&webview, &state)?;
    let ephemeral = options.ephemeral.unwrap_or(false);
    let options = options.into_core()?;
    let state = Arc::clone(state.inner());
    // Keep the transition guard alive even if the invoking webview disappears.
    tauri::async_runtime::spawn(async move {
        let guard = state
            .engine
            .auth
            .try_lock()
            .map_err(|_| NativeError::new("authentication_busy"))?;
        let (owner, generation, cancel) = state.engine.begin_auth(webview.window().label())?;
        let result = tokio::select! { biased;
            () = cancel.cancelled() => Err(NativeError::new("cancelled")),
            value = state.platform.sign_in(&state.engine.client, options, ephemeral) => value
        };
        if cancel.is_cancelled() {
            // Core installation may already be detached. Queue clearing behind
            // it before allowing any new account-dependent operation.
            let _ = state.engine.client.sign_out().await;
        }
        state.engine.check(generation)?;
        state.engine.invalidate()?;
        drop(owner);
        drop(guard);
        result?;
        state.engine.session().await
    })
    .await
    .map_err(|_| NativeError::new("internal_error"))?
}
#[tauri::command]
pub async fn sign_out<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, Arc<PluginState<R>>>,
) -> Result<Value> {
    authorized(&webview, &state)?;
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn(async move {
        let (generation, _) = state.engine.invalidate()?;
        let _guard = state.engine.auth.lock().await;
        let revoked = state
            .engine
            .client
            .sign_out()
            .await
            .map_err(NativeError::from)?;
        state.engine.check(generation)?;
        Ok(json!({"revoked":revoked,"generation":generation.to_string()}))
    })
    .await
    .map_err(|_| NativeError::new("internal_error"))?
}
#[tauri::command]
pub async fn balance<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, Arc<PluginState<R>>>,
) -> Result<Value> {
    authorized(&webview, &state)?;
    state
        .engine
        .read(async {
            wire::value(
                &state
                    .engine
                    .client
                    .balance()
                    .await
                    .map_err(NativeError::from)?,
            )
        })
        .await
}
#[tauri::command]
pub async fn grant<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, Arc<PluginState<R>>>,
) -> Result<Value> {
    authorized(&webview, &state)?;
    state
        .engine
        .read(async {
            wire::value(
                &state
                    .engine
                    .client
                    .grant()
                    .await
                    .map_err(NativeError::from)?,
            )
        })
        .await
}
#[tauri::command]
pub async fn models<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, Arc<PluginState<R>>>,
) -> Result<Value> {
    authorized(&webview, &state)?;
    state
        .engine
        .read(async {
            wire::value(
                &state
                    .engine
                    .client
                    .ai()
                    .models()
                    .await
                    .map_err(NativeError::from)?,
            )
        })
        .await
}
#[tauri::command]
pub async fn estimate<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, Arc<PluginState<R>>>,
    request: Value,
) -> Result<Value> {
    authorized(&webview, &state)?;
    let request = wire::chat_request(request)?;
    state
        .engine
        .read(async {
            wire::value(
                &state
                    .engine
                    .client
                    .ai()
                    .estimate(&request)
                    .await
                    .map_err(NativeError::from)?,
            )
        })
        .await
}
// Deprecated in the core since 0.4.0 (apps don't sell 2Z), kept working for
// apps built on 0.3.0.
#[allow(deprecated)]
#[tauri::command]
pub async fn create_purchase<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, Arc<PluginState<R>>>,
    request: wire::PurchaseRequest,
) -> Result<Value> {
    authorized(&webview, &state)?;
    wire::key(&request.idempotency_key)?;
    let quantity = f2z_sdk::proto::Whole2z::new(wire::decimal(&request.quantity_2z)?);
    let platform = if cfg!(target_os = "ios") {
        f2z_sdk::purchase::Platform::Ios
    } else if cfg!(target_os = "android") {
        f2z_sdk::purchase::Platform::Android
    } else {
        f2z_sdk::purchase::Platform::Desktop
    };
    let mut core =
        f2z_sdk::purchase::PurchaseRequest::card(quantity, platform, state.checkout_return.clone());
    core.rail = match request.rail.as_str() {
        "card" => f2z_sdk::purchase::Rail::Card,
        "zcash" => f2z_sdk::purchase::Rail::Zcash,
        _ => return Err(NativeError::new("invalid_rail")),
    };
    if core.rail == f2z_sdk::purchase::Rail::Zcash {
        core.return_url = None;
    }
    core.idempotency_key = Some(request.idempotency_key.clone());
    state
        .engine
        .read(async {
            wire::purchase(
                &state
                    .engine
                    .client
                    .create_purchase(&core)
                    .await
                    .map_err(NativeError::from)?,
            )
        })
        .await
        .map_err(|e| e.key(&request.idempotency_key))
}
// Deprecated in the core since 0.4.0 (apps don't sell 2Z), kept working for
// apps built on 0.3.0.
#[allow(deprecated)]
#[tauri::command]
pub async fn purchase<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, Arc<PluginState<R>>>,
    id: String,
) -> Result<Value> {
    authorized(&webview, &state)?;
    state
        .engine
        .read(async {
            wire::purchase(
                &state
                    .engine
                    .client
                    .purchase(&id)
                    .await
                    .map_err(NativeError::from)?,
            )
        })
        .await
}
// Deprecated in the core since 0.4.0 (apps don't sell 2Z), kept working for
// apps built on 0.3.0.
#[allow(deprecated)]
#[tauri::command]
pub async fn wait_for_purchase<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, Arc<PluginState<R>>>,
    id: String,
    options: wire::PollOptions,
) -> Result<Value> {
    authorized(&webview, &state)?;
    let duration = options.duration()?;
    state
        .engine
        .read(async {
            wire::purchase(
                &state
                    .engine
                    .client
                    .wait_for_purchase(&id, f2z_sdk::purchase::PollOptions::max_wait(duration))
                    .await
                    .map_err(NativeError::from)?,
            )
        })
        .await
}
// Deprecated in the core since 0.4.0 (apps don't sell 2Z), kept working for
// apps built on 0.3.0.
#[allow(deprecated)]
#[tauri::command]
pub async fn open_checkout<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, Arc<PluginState<R>>>,
    id: String,
) -> Result<()> {
    authorized(&webview, &state)?;
    state
        .engine
        .read(async {
            let purchase = state
                .engine
                .client
                .purchase(&id)
                .await
                .map_err(NativeError::from)?;
            let url = purchase
                .checkout_url()
                .ok_or_else(|| NativeError::new("checkout_unavailable"))?;
            state.platform.open(url.into()).await
        })
        .await
}
/// `{web origin}/account/apps?client_id=…`, built from native configuration.
#[tauri::command]
pub async fn manage_account_url<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, Arc<PluginState<R>>>,
) -> Result<String> {
    authorized(&webview, &state)?;
    Ok(state.engine.client.manage_account_url().to_owned())
}
/// `{web origin}/account/delete`.
#[tauri::command]
pub async fn delete_account_url<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, Arc<PluginState<R>>>,
) -> Result<String> {
    authorized(&webview, &state)?;
    Ok(state.engine.client.delete_account_url().to_owned())
}
/// Open the manage-account page in the system browser, never a webview. The
/// URL comes from native configuration: JavaScript cannot choose what opens.
#[tauri::command]
pub async fn open_manage_account<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, Arc<PluginState<R>>>,
) -> Result<()> {
    authorized(&webview, &state)?;
    let url = state.engine.client.manage_account_url().to_owned();
    state.platform.open_external(url).await
}
/// Open the delete-account page in the system browser, never a webview.
#[tauri::command]
pub async fn open_delete_account<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, Arc<PluginState<R>>>,
) -> Result<()> {
    authorized(&webview, &state)?;
    let url = state.engine.client.delete_account_url().to_owned();
    state.platform.open_external(url).await
}
/// `{web origin}/buy-2z?client_id=…`: the user's Free2Z billing page, built
/// from native configuration. Opt-in: only reachable through the explicit
/// `f2z:allow-billing-url` permission, which no default grants.
#[tauri::command]
pub async fn billing_url<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, Arc<PluginState<R>>>,
) -> Result<String> {
    authorized(&webview, &state)?;
    Ok(state.engine.client.billing_url().to_owned())
}
/// Open the Free2Z billing page in the system browser, never a webview. The
/// URL comes from native configuration: JavaScript cannot choose what opens.
/// Opt-in: only reachable through the explicit `f2z:allow-open-billing`
/// permission, which no default grants. A store build that must not link to
/// payment (Google Play; iOS outside the US storefront) never grants it.
#[tauri::command]
pub async fn open_billing<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, Arc<PluginState<R>>>,
) -> Result<()> {
    authorized(&webview, &state)?;
    let url = state.engine.client.billing_url().to_owned();
    state.platform.open_external(url).await
}
#[tauri::command]
pub async fn start_chat<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, Arc<PluginState<R>>>,
    request: Value,
    operation: wire::ChatOperation,
) -> Result<Value> {
    authorized(&webview, &state)?;
    wire::key(&operation.operation_id)?;
    wire::key(&operation.idempotency_key)?;
    let request = wire::chat_request(request).map_err(|e| e.key(&operation.idempotency_key))?;
    state
        .engine
        .start(webview.window().label(), request, operation)
        .await
}
#[tauri::command]
pub async fn next_chat<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, Arc<PluginState<R>>>,
    operation_id: String,
) -> Result<Option<Value>> {
    authorized(&webview, &state)?;
    state
        .engine
        .next(webview.window().label(), &operation_id)
        .await
}
#[tauri::command]
pub async fn cancel_chat<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, Arc<PluginState<R>>>,
    operation_id: String,
) -> Result<()> {
    authorized(&webview, &state)?;
    state.engine.cancel(webview.window().label(), &operation_id)
}
#[tauri::command]
pub async fn call<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, Arc<PluginState<R>>>,
    call_id: String,
) -> Result<Value> {
    authorized(&webview, &state)?;
    state
        .engine
        .read(async {
            wire::call_record(
                &state
                    .engine
                    .client
                    .ai()
                    .call(&call_id)
                    .await
                    .map_err(NativeError::from)?,
            )
        })
        .await
}
#[tauri::command]
pub async fn wait_for_call<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, Arc<PluginState<R>>>,
    call_id: String,
    options: wire::PollOptions,
) -> Result<Value> {
    authorized(&webview, &state)?;
    let duration = options.duration()?;
    state
        .engine
        .read(async {
            wire::call_record(
                &state
                    .engine
                    .client
                    .ai()
                    .wait_for_call(&call_id, duration)
                    .await
                    .map_err(NativeError::from)?,
            )
        })
        .await
}
/// Report a call's AI output (`spec/chat-api.md` §7.1). The reason and detail are
/// checked here first, so a refused value never reaches the network.
#[tauri::command]
pub async fn report_call<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, Arc<PluginState<R>>>,
    call_id: String,
    reason: String,
    detail: Option<String>,
) -> Result<Value> {
    authorized(&webview, &state)?;
    let reason = wire::report_request(
        &call_id,
        &reason,
        detail.as_deref(),
        state.engine.client.child_directed(),
    )?;
    state
        .engine
        .read(async {
            wire::value(
                &state
                    .engine
                    .client
                    .ai()
                    .report_call(&call_id, reason, detail.as_deref())
                    .await
                    .map_err(NativeError::from)?,
            )
        })
        .await
}
