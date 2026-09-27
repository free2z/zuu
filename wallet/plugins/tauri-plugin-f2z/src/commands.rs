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
    let options = options.into_core()?;
    let _guard = state
        .engine
        .auth
        .try_lock()
        .map_err(|_| NativeError::new("authentication_busy"))?;
    let (_owner, generation, cancel) = state.engine.begin_auth(webview.window().label())?;
    let result = tokio::select! { biased;
        () = cancel.cancelled() => Err(NativeError::new("cancelled")),
        value = state.platform.sign_in(&state.engine.client, options) => value
    };
    state.engine.check(generation)?;
    result?;
    state.engine.session().await
}
#[tauri::command]
pub async fn sign_out<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, Arc<PluginState<R>>>,
) -> Result<Value> {
    authorized(&webview, &state)?;
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
