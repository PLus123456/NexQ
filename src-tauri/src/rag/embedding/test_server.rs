//! A tiny HTTP/1.1 server on a raw tokio socket for tests: one request per
//! connection, answered by a closure. No extra dev-dependencies.

use std::net::SocketAddr;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

#[derive(Debug, Clone)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub query: Option<String>,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<String> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.clone())
    }

    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
}

#[derive(Debug, Clone)]
pub struct Reply {
    status: u16,
    content_type: &'static str,
    body: Vec<u8>,
    headers: Vec<(String, String)>,
    delay: Option<Duration>,
}

impl Reply {
    pub fn json(status: u16, value: Value) -> Self {
        Self { status, content_type: "application/json", body: value.to_string().into_bytes(), headers: Vec::new(), delay: None }
    }

    pub fn text(status: u16, text: &str) -> Self {
        Self { status, content_type: "text/plain", body: text.as_bytes().to_vec(), headers: Vec::new(), delay: None }
    }

    pub fn with_header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_string(), value.to_string()));
        self
    }

    pub fn delayed(mut self, delay: Duration) -> Self {
        self.delay = Some(delay);
        self
    }
}

type Handler = dyn Fn(Request) -> Reply + Send + Sync;

pub struct FakeServer {
    addr: SocketAddr,
    hits: Arc<AtomicUsize>,
    failure: Arc<Mutex<Option<String>>>,
    task: JoinHandle<()>,
}

impl FakeServer {
    pub async fn start<F>(handler: F) -> Self
    where
        F: Fn(Request) -> Reply + Send + Sync + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let hits = Arc::new(AtomicUsize::new(0));
        let failure: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let handler: Arc<Handler> = Arc::new(handler);
        let (h, f) = (hits.clone(), failure.clone());
        let task = tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else { break };
                let (handler, hits, failure) = (handler.clone(), h.clone(), f.clone());
                tokio::spawn(async move {
                    let _ = serve(socket, handler, hits, failure).await;
                });
            }
        });
        Self { addr, hits, failure, task }
    }

    /// `http://127.0.0.1:<port>`.
    pub fn base(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// Requests answered so far.
    pub fn hits(&self) -> usize {
        self.hits.load(Ordering::SeqCst)
    }
}

impl Drop for FakeServer {
    fn drop(&mut self) {
        self.task.abort();
        if let Some(message) = self.failure.lock().unwrap().take() {
            if !std::thread::panicking() {
                panic!("fake server handler failed: {message}");
            }
        }
    }
}

async fn serve(
    mut socket: tokio::net::TcpStream,
    handler: Arc<Handler>,
    hits: Arc<AtomicUsize>,
    failure: Arc<Mutex<Option<String>>>,
) -> std::io::Result<()> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let header_end = loop {
        let n = socket.read(&mut chunk).await?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or_default().split(' ');
    let method = first.next().unwrap_or_default().to_string();
    let target = first.next().unwrap_or_default().to_string();
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), Some(q.to_string())),
        None => (target, None),
    };
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(n, v)| (n.trim().to_string(), v.trim().to_string()))
        .collect();
    let length = headers
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = buf[header_end..].to_vec();
    while body.len() < length {
        let n = socket.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    let request = Request { method, path, query, headers, body };
    let reply = match std::panic::catch_unwind(AssertUnwindSafe(|| handler(request))) {
        Ok(reply) => reply,
        Err(panic) => {
            let message = panic
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_else(|| "panic".to_string());
            failure.lock().unwrap().get_or_insert(message.clone());
            Reply::text(500, &format!("handler panicked: {message}"))
        }
    };
    hits.fetch_add(1, Ordering::SeqCst);
    if let Some(delay) = reply.delay {
        tokio::time::sleep(delay).await;
    }
    let mut out = format!(
        "HTTP/1.1 {} X\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n",
        reply.status,
        reply.content_type,
        reply.body.len()
    );
    for (n, v) in &reply.headers {
        out.push_str(&format!("{n}: {v}\r\n"));
    }
    out.push_str("\r\n");
    socket.write_all(out.as_bytes()).await?;
    socket.write_all(&reply.body).await?;
    socket.shutdown().await
}
