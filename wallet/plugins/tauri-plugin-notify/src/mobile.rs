use super::*;
struct Mobile<'a, R: Runtime>(&'a State<R>);
impl<R: Runtime> crate::engine::Port for Mobile<'_, R> {
    fn invoke(
        &self,
        command: &str,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, &'static str> {
        self.0
            .handle
            .run_mobile_plugin(command, args)
            .map_err(|_| "unavailable")
    }
    fn post<'a>(
        &'a self,
        origin: &'a reqwest::Url,
        route: &'a str,
        value: serde_json::Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), &'static str>> + Send + 'a>>
    {
        Box::pin(async move { crate::engine::http_post(origin, route, &value).await })
    }
}
pub async fn run<R: Runtime>(
    app: &tauri::AppHandle<R>,
    operation: &str,
) -> Result<Status, &'static str> {
    let state = app.state::<State<R>>();
    let _serial = state.serial.lock().await;
    crate::engine::run(&Mobile(&state), operation).await
}

pub async fn startup<R: Runtime>(app: &tauri::AppHandle<R>) {
    if !crate::engine::configured() {
        let _ = run(app, "disable").await;
        return;
    }
    let state = app.state::<State<R>>();
    let handle = app.clone();
    let channel = tauri::ipc::Channel::<serde_json::Value>::new(move |_| {
        schedule(&handle);
        Ok(())
    });
    let _ = state.handle.run_mobile_plugin::<serde_json::Value>(
        "registerListener",
        serde_json::json!({"event":"changed","handler":channel}),
    );
    let _ = state
        .handle
        .run_mobile_plugin::<serde_json::Value>("resume", serde_json::json!({}));
    schedule(app);
}
/// Coalesce actual native token callbacks, never retry a failed network request
/// without another callback/user reconciliation. At most one running operation
/// and one pending hint; shutdown prevents later work.
fn schedule<R: Runtime>(app: &tauri::AppHandle<R>) {
    use std::sync::atomic::Ordering;
    let state = app.state::<State<R>>();
    if state.stopping.load(Ordering::Acquire) {
        return;
    }
    state.pending.store(true, Ordering::Release);
    if state.running.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri::Emitter;
        loop {
            let state = app.state::<State<R>>();
            state.pending.store(false, Ordering::Release);
            if !state.stopping.load(Ordering::Acquire) {
                let _ = run(&app, "reconcile").await;
                let _ = app.emit("notify://changed", ());
            }
            state.running.store(false, Ordering::Release);
            if state.stopping.load(Ordering::Acquire)
                || !state.pending.load(Ordering::Acquire)
                || state.running.swap(true, Ordering::AcqRel)
            {
                break;
            }
        }
    });
}
