//! A tiny `fetch` proxy for the frontend's AI calls.
//!
//! Why not the webview's own fetch? Most AI APIs block browser CORS. Why not
//! tauri-plugin-http? It builds a new HTTP client for every request, which means a
//! fresh TCP + TLS handshake (100-300 ms) before every single answer.
//!
//! Here one shared client keeps connections alive, `warm` opens them before they're
//! needed, and response bodies stream back to JS as raw bytes over a channel.

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU32, Ordering},
    LazyLock, Mutex,
};
use std::time::Duration;
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::oneshot;

static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .pool_idle_timeout(Duration::from_secs(300))
        .tcp_keepalive(Duration::from_secs(30))
        .tcp_nodelay(true)
        .connect_timeout(Duration::from_secs(10))
        .build()
        .expect("failed to build HTTP client")
});

static NEXT_ID: AtomicU32 = AtomicU32::new(1);
/// Cancel switches for bodies that are still streaming.
static INFLIGHT: LazyLock<Mutex<HashMap<u32, oneshot::Sender<()>>>> = LazyLock::new(Default::default);

#[derive(Serialize)]
pub struct ProxyHead {
    id: u32,
    status: u16,
    headers: Vec<(String, String)>,
}

/// Sends a request and returns once the response headers arrive. The body is
/// streamed into `body` as raw chunks, then one empty chunk marks the end.
#[tauri::command]
pub async fn proxy_fetch(
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
    on_body: Channel<InvokeResponseBody>,
) -> Result<ProxyHead, String> {
    let mut map = HeaderMap::new();
    for (k, v) in headers {
        let name = HeaderName::from_bytes(k.as_bytes()).map_err(|e| e.to_string())?;
        map.insert(name, HeaderValue::from_str(&v).map_err(|e| e.to_string())?);
    }
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut req = CLIENT.request(method, &url).headers(map);
    if let Some(body) = body {
        req = req.body(body);
    }

    let res = req.send().await.map_err(|e| format!("network error: {e}"))?;
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let head = ProxyHead {
        id,
        status: res.status().as_u16(),
        headers: res
            .headers()
            .iter()
            .filter_map(|(k, v)| Some((k.to_string(), v.to_str().ok()?.to_string())))
            .collect(),
    };

    let (cancel, mut cancelled) = oneshot::channel();
    INFLIGHT.lock().unwrap().insert(id, cancel);

    tauri::async_runtime::spawn(async move {
        let mut stream = res.bytes_stream();
        loop {
            tokio::select! {
                _ = &mut cancelled => break,
                chunk = stream.next() => match chunk {
                    Some(Ok(chunk)) if chunk.is_empty() => {}
                    Some(Ok(chunk)) => {
                        if on_body.send(InvokeResponseBody::Raw(chunk.to_vec())).is_err() {
                            break;
                        }
                    }
                    _ => break,
                },
            }
        }
        let _ = on_body.send(InvokeResponseBody::Raw(Vec::new()));
        INFLIGHT.lock().unwrap().remove(&id);
    });
    Ok(head)
}

/// Cancels a streaming body, e.g. when a newer answer replaces this one.
#[tauri::command]
pub fn proxy_abort(id: u32) {
    if let Some(cancel) = INFLIGHT.lock().unwrap().remove(&id) {
        let _ = cancel.send(());
    }
}

/// Opens (or refreshes) pooled connections to these origins, so the first real
/// request skips DNS, TCP and TLS setup. Any HTTP status counts as warm.
#[tauri::command]
pub async fn warm(urls: Vec<String>) {
    let requests = urls.into_iter().map(|url| async move {
        let _ = CLIENT.head(url).timeout(Duration::from_secs(5)).send().await;
    });
    futures_util::future::join_all(requests).await;
}
