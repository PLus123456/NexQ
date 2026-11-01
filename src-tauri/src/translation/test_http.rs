// src-tauri/src/translation/test_http.rs
//! A minimal local HTTP/1.1 server for the provider tests: each connection
//! gets the next canned reply (then `Connection: close`), and every request
//! is recorded. Plain tokio TCP, so the tests need no dev-dependency and
//! never reach a real service.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

pub struct Reply {
    status: u16,
    body: String,
}

impl Reply {
    pub fn json(status: u16, body: &str) -> Self {
        Self { status, body: body.to_string() }
    }
}

#[derive(Debug, Clone)]
pub struct Recorded {
    pub method: String,
    /// The request target: path and query.
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Recorded {
    /// Case-insensitive.
    pub fn header(&self, name: &str) -> Option<String> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.clone())
    }

    pub fn body_text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    /// The form-encoded body (a repeated field keeps its last value).
    pub fn form(&self) -> HashMap<String, String> {
        url::form_urlencoded::parse(&self.body).into_owned().collect()
    }
}

pub struct FakeServer {
    addr: SocketAddr,
    requests: Arc<Mutex<Vec<Recorded>>>,
}

impl FakeServer {
    pub async fn start(replies: Vec<Reply>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind a local port");
        let addr = listener.local_addr().expect("local address");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = requests.clone();
        tokio::spawn(async move {
            let mut replies = replies.into_iter();
            while let Ok((stream, _)) = listener.accept().await {
                let reply = replies.next().unwrap_or(Reply { status: 500, body: "no more replies".into() });
                serve(stream, reply, &recorded).await;
            }
        });
        Self { addr, requests }
    }

    /// `http://127.0.0.1:<port>`
    pub fn url(&self) -> String {
        format!("http://{}", self.addr)
    }

    pub fn request(&self, index: usize) -> Recorded {
        self.requests
            .lock()
            .unwrap()
            .get(index)
            .cloned()
            .unwrap_or_else(|| panic!("no request #{index} received"))
    }

    pub fn request_count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

async fn serve(mut stream: TcpStream, reply: Reply, recorded: &Mutex<Vec<Recorded>>) {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        if let Some(pos) = find(&buffer, b"\r\n\r\n") {
            break pos;
        }
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => buffer.extend_from_slice(&chunk[..n]),
        }
    };

    let head = String::from_utf8_lossy(&buffer[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next().unwrap_or_default().split(' ');
    let method = request_line.next().unwrap_or_default().to_string();
    let path = request_line.next().unwrap_or_default().to_string();
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(n, v)| (n.trim().to_string(), v.trim().to_string()))
        .collect();
    let length = headers
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.parse::<usize>().ok())
        .unwrap_or(0);

    let mut body = buffer[head_end + 4..].to_vec();
    while body.len() < length {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => body.extend_from_slice(&chunk[..n]),
        }
    }
    body.truncate(length);

    recorded.lock().unwrap().push(Recorded { method, path, headers, body });

    let response = format!(
        "HTTP/1.1 {} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        reply.status,
        reply.body.len(),
        reply.body
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}
