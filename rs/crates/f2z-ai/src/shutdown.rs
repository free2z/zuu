//! The shutdown signal: `SIGTERM` (what Kubernetes sends) or Ctrl-C.

use std::future::Future;

/// Register for `SIGTERM` and Ctrl-C **now**, and return a future that
/// resolves on the first of them.
///
/// Registration happens in this call, not on first poll, so that a signal
/// delivered between this call and the first `.await` is not lost — and so a
/// test can register, then send itself a real `SIGTERM`. Must be called inside
/// a tokio runtime.
///
/// # Errors
///
/// The OS refused the `SIGTERM` handler.
pub fn terminate_signal() -> std::io::Result<impl Future<Output = ()> + Send + 'static> {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        Ok(async move {
            tokio::select! {
                _ = term.recv() => {}
                _ = tokio::signal::ctrl_c() => {}
            }
        })
    }
    #[cfg(not(unix))]
    {
        Ok(async move {
            let _ = tokio::signal::ctrl_c().await;
        })
    }
}

/// Resolve once `flag` is (or becomes) true, or its sender is gone.
///
/// A wrapper rather than `flag.wait_for(..)` inline, because `wait_for`
/// returns a borrow guard and a `select!` arm holding one is not `Send`.
pub(crate) async fn raised(flag: &mut tokio::sync::watch::Receiver<bool>) {
    let _ = flag.wait_for(|raised| *raised).await;
}
