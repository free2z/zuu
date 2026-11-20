include!("../command_registry.rs");
macro_rules! command_handler { ($($command:ident),* $(,)?) => { tauri::generate_handler![$($command),*] }; }
// Native notification transport. No wallet, content, billing or account authority.
#[cfg(mobile)]
use tauri::Manager;
use tauri::{
    Runtime,
    plugin::{Builder, TauriPlugin},
};
#[cfg(any(mobile, test))]
mod engine;
#[cfg(mobile)]
mod mobile;
#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_notify);
pub use f2z_notify_proto::Status;
#[cfg(mobile)]
struct State<R: Runtime> {
    handle: tauri::plugin::PluginHandle<R>,
    serial: tokio::sync::Mutex<()>,
    pending: std::sync::atomic::AtomicBool,
    running: std::sync::atomic::AtomicBool,
    stopping: std::sync::atomic::AtomicBool,
}
#[cfg(not(mobile))]
fn unsupported() -> Status {
    Status {
        state: "unsupported".into(),
        wake: false,
    }
}
macro_rules! command {
    ($name:ident) => {
        #[tauri::command]
        async fn $name<R: Runtime>(_app: tauri::AppHandle<R>) -> Result<Status, String> {
            #[cfg(mobile)]
            {
                mobile::run(&_app, stringify!($name))
                    .await
                    .map_err(str::to_owned)
            }
            #[cfg(not(mobile))]
            {
                Ok(unsupported())
            }
        }
    };
}
command!(status);
command!(enable);
command!(disable);
command!(reconcile);
command!(test_wake);
/// The owning app calls this on logout/data reset before deleting its local state.
/// No account token or identifier is accepted or sent.
pub async fn disconnect<R: Runtime>(_app: &tauri::AppHandle<R>) -> Result<(), &'static str> {
    #[cfg(mobile)]
    {
        mobile::run(_app, "disable").await?;
    }
    Ok(())
}
/// Rust-only local notification after native wallet verification. No IPC command and
/// no amounts, transaction IDs or wallet identity arguments.
pub fn payment_verified<R: Runtime>(_app: &tauri::AppHandle<R>) -> Result<(), &'static str> {
    #[cfg(mobile)]
    {
        let state = _app.state::<State<R>>();
        state
            .handle
            .run_mobile_plugin::<serde_json::Value>("payment", serde_json::json!({}))
            .map_err(|_| "unavailable")?;
    }
    Ok(())
}
/// Independent plugin; desktop explicitly has no APNs/FCM implementation.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("notify")
        .invoke_handler(with_notify_commands!(command_handler))
        .setup(|_app, _api| {
            #[cfg(mobile)]
            {
                #[cfg(target_os = "ios")]
                let handle = _api.register_ios_plugin(init_plugin_notify)?;
                #[cfg(target_os = "android")]
                let handle = _api.register_android_plugin("cash.free2z.notify", "NotifyPlugin")?;
                _app.manage(State {
                    handle,
                    serial: tokio::sync::Mutex::new(()),
                    pending: false.into(),
                    running: false.into(),
                    stopping: false.into(),
                });
                let app = _app.clone();
                tauri::async_runtime::spawn(async move {
                    mobile::startup(&app).await;
                });
            }
            Ok(())
        })
        .on_event(|_app, event| {
            #[cfg(mobile)]
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                use std::sync::atomic::Ordering;
                _app.state::<State<R>>()
                    .stopping
                    .store(true, Ordering::Release);
            }
            #[cfg(not(mobile))]
            let _ = event;
        })
        .build()
}
