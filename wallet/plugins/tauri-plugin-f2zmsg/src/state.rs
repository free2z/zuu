//! The plugin's managed state, and the one accessor commands use.
//!
//! Mirrors `tauri-plugin-zcash`'s `ZcashExt`: the state is registered with
//! `app.manage(..)` in `setup`, and every command reaches it through a trait
//! implemented for anything that is a `Manager<R>`.

use std::sync::Arc;

use f2z_msg_store::SqliteBackend;
use tauri::{Manager, Runtime};

use crate::engine::Engine;

/// The backend the shipping plugin uses.
///
/// `SqliteBackend::open` is the durable one — WAL, `synchronous = FULL`, every
/// pragma verified at open and the open **refused** otherwise — and durability
/// is not a nicety here: §11.2 says a client that cannot promise it must not
/// ACK, and `Durability::may_acknowledge()` is what the engine consults before
/// it sends one. An in-memory store answers `false` and enters no-ACK mode, so
/// a fallback that quietly opened one would silently stop deleting relay copies
/// rather than fail.
pub type Backend = SqliteBackend;

/// What `app.manage` holds.
pub struct F2zMsg<R: Runtime> {
    engine: Arc<Engine<Backend>>,
    _app: tauri::AppHandle<R>,
}

impl<R: Runtime> F2zMsg<R> {
    #[must_use]
    pub const fn new(app: tauri::AppHandle<R>, engine: Arc<Engine<Backend>>) -> Self {
        Self { engine, _app: app }
    }

    /// The engine every command delegates to.
    #[must_use]
    pub fn engine(&self) -> &Engine<Backend> {
        &self.engine
    }

    /// A cloned handle, for the receive task and for the app crate's
    /// enrollment commands.
    #[must_use]
    pub fn engine_handle(&self) -> Arc<Engine<Backend>> {
        Arc::clone(&self.engine)
    }
}

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to
/// reach the messaging engine.
pub trait F2zMsgExt<R: Runtime> {
    fn f2zmsg(&self) -> &F2zMsg<R>;
}

impl<R: Runtime, T: Manager<R>> F2zMsgExt<R> for T {
    fn f2zmsg(&self) -> &F2zMsg<R> {
        self.state::<F2zMsg<R>>().inner()
    }
}
