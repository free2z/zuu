//! The plugin's managed state, and the one accessor commands use.
//!
//! Mirrors `tauri-plugin-zcash`'s `ZcashExt`: the state is registered with
//! `app.manage(..)` in `setup`, and every command reaches it through a trait
//! implemented for anything that is a `Manager<R>`.
//!
//! # Why this holds an outcome and not an engine (#753)
//!
//! A plugin's `setup` hook is fallible, and an `Err` from it makes
//! `tauri::Builder::build()` fail — which `wallet/zuuli/src-tauri/src/lib.rs`
//! ends by `.expect(..)`ing. So for as long as this state was *only* ever
//! constructed from a successfully opened store, a messaging store that would
//! not open took the whole wallet down at launch. WAL is unavailable on some
//! filesystems, a data directory can be full or read-only, and a half-written
//! `f2zmsg.sqlite` from a killed process is a state a real device reaches; in
//! every one of those the correct product behaviour is *messaging is
//! unavailable and the wallet works*.
//!
//! Failing soft cannot be done by skipping `app.manage(..)`, because
//! [`F2zMsgExt::f2zmsg`] is `self.state::<F2zMsg<R>>().inner()` and `state()`
//! panics on an unmanaged type: all forty-three commands would panic rather
//! than refuse. **The state has to exist and answer.** So it holds either the
//! engine or the §8 [`ErrorCode`](crate::models::ErrorCode) that stopped the
//! engine from being built, and [`F2zMsg::engine`] returns a `Result` — which
//! makes the refusal the compiler's business rather than a convention: a
//! command cannot reach the engine without handling the fault.

use std::sync::Arc;

use f2z_msg_store::SqliteBackend;
use tauri::{Manager, Runtime};

use crate::engine::Engine;
use crate::error::{Error, Result};
use crate::models::{EngineState, EngineStatus};

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

/// What `app.manage` holds: the **outcome** of the plugin's setup.
///
/// See the module header for why this is an outcome and not an engine.
pub struct F2zMsg<R: Runtime> {
    engine: core::result::Result<Arc<Engine<Backend>>, Error>,
    _app: tauri::AppHandle<R>,
}

impl<R: Runtime> F2zMsg<R> {
    /// The state a `setup` that opened the store leaves behind.
    #[must_use]
    pub const fn new(app: tauri::AppHandle<R>, engine: Arc<Engine<Backend>>) -> Self {
        Self {
            engine: Ok(engine),
            _app: app,
        }
    }

    /// The state a `setup` that could **not** open the store leaves behind.
    ///
    /// `fault` is the §8 code the UI will see on every command, plus the
    /// context that only reaches the log.
    #[must_use]
    pub const fn faulted(app: tauri::AppHandle<R>, fault: Error) -> Self {
        Self {
            engine: Err(fault),
            _app: app,
        }
    }

    /// The engine every command delegates to.
    ///
    /// # Errors
    ///
    /// The §8 code that stopped the engine from being built, when the store
    /// did not open. Returning a `Result` here rather than panicking is the
    /// whole fix for #753, and returning it *by type* is what makes every one
    /// of the forty-three commands handle it: there is no way to reach the
    /// engine that does not go through this.
    pub fn engine(&self) -> Result<&Engine<Backend>> {
        match &self.engine {
            Ok(engine) => Ok(engine),
            Err(fault) => Err(fault.clone()),
        }
    }

    /// A cloned handle, for the receive task and for the app crate's
    /// enrollment commands.
    ///
    /// # Errors
    ///
    /// As [`F2zMsg::engine`].
    pub fn engine_handle(&self) -> Result<Arc<Engine<Backend>>> {
        match &self.engine {
            Ok(engine) => Ok(Arc::clone(engine)),
            Err(fault) => Err(fault.clone()),
        }
    }

    /// The fault, when there is one — for `get_engine_status`, which answers
    /// §6.1's `faulted` instead of refusing so the UI can say *why* messaging
    /// is unavailable rather than render an empty screen.
    #[must_use]
    pub const fn fault(&self) -> Option<&Error> {
        match &self.engine {
            Ok(_) => None,
            Err(fault) => Some(fault),
        }
    }

    /// §6.1's `faulted` status, when setup faulted.
    ///
    /// Every count is zero and `enrolled` is false because the store is the
    /// only thing that knows otherwise and it is precisely what did not open —
    /// reporting a remembered value here would be an invention.
    #[must_use]
    pub fn faulted_status(&self) -> Option<EngineStatus> {
        self.fault().map(|fault| EngineStatus {
            state: EngineState::Faulted,
            enrolled: false,
            handle: None,
            relays_connected: 0,
            relays_configured: 0,
            witness_threshold_met: false,
            independent_witnesses: 0,
            pending_inbound: 0,
            unacknowledged_alarms: 0,
            last_error: Some(fault.code()),
        })
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
