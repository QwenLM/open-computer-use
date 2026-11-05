use std::future::Future;

use cua_driver_core::protocol::ToolResult;

/// Keep the bounded read-only pipe exchange alive after its caller stops
/// waiting, so an authenticated terminal response can still retire its worker.
pub(crate) async fn finish<F>(read: F) -> anyhow::Result<ToolResult>
where
    F: Future<Output = anyhow::Result<ToolResult>> + Send + 'static,
{
    let lifetime = cua_driver_core::tool::retain_dispatch_lifetime();
    tokio::spawn(async move {
        let _lifetime = lifetime;
        read.await
    })
    .await
    .map_err(|error| anyhow::anyhow!("UIAccess readback task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn cancelled_caller_still_consumes_one_terminal_cleanup() {
        let (entered_tx, entered_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let (retired_tx, retired_rx) = oneshot::channel();
        let dispatched = Arc::new(AtomicUsize::new(0));
        let calls = dispatched.clone();
        let caller = tokio::spawn(finish(async move {
            calls.fetch_add(1, Ordering::SeqCst);
            entered_tx.send(()).unwrap();
            release_rx.await.unwrap();
            // The mock authenticated response requires worker retirement.
            retired_tx.send(()).unwrap();
            Ok(ToolResult::text("readback timed out"))
        }));
        entered_rx.await.unwrap();
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        release_tx.send(()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), retired_rx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(dispatched.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn completed_caller_receives_the_original_result() {
        let result = finish(async { Ok(ToolResult::text("terminal result")) })
            .await
            .unwrap();
        assert!(
            matches!(&result.content[0], cua_driver_core::protocol::Content::Text { text, .. } if text == "terminal result")
        );
    }
}
