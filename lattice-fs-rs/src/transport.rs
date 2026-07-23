//! The transport seam. A transport carries a request/response and (optionally)
//! a change stream. Two impls: Eyre (HTTP) and lick (unix-socket IPC). The
//! projection is written against this trait and never knows which is in use.

use serde_json::Value;

/// A transport error carrying an HTTP-style status so the projection maps it to
/// an errno identically regardless of transport (lick replies use the same codes).
#[derive(Debug)]
pub struct TErr {
    pub code: u16,
    pub msg: String,
}

impl TErr {
    pub fn new(code: u16, msg: impl Into<String>) -> Self {
        Self { code, msg: msg.into() }
    }
}

impl std::fmt::Display for TErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} {}", self.code, self.msg)
    }
}

pub trait Transport: Send + Sync {
    /// GET-like: fetch `path` with query params, return the raw response body.
    fn get_bytes(&self, path: &str, query: &[(&str, &str)]) -> Result<Vec<u8>, TErr>;

    /// POST-like: send `body` to `path` with query params, return the response body.
    fn post(&self, path: &str, query: &[(&str, &str)], body: &[u8]) -> Result<Vec<u8>, TErr>;

    /// Our ship @p (e.g. "~tyr"), for building the /x/…/err path.
    fn ship(&self) -> Result<String, TErr>;

    /// Best-effort change notifications. Blocks, calling `on_change` per event.
    /// Default no-op: the core's TTL poll is the freshness floor (Eyre uses this;
    /// lick overrides it with a real push stream).
    fn watch(&self, _on_change: &(dyn Fn() + Send + Sync)) {}

    /// Provided: GET and parse JSON.
    fn get_json(&self, path: &str, query: &[(&str, &str)]) -> Result<Value, TErr> {
        let b = self.get_bytes(path, query)?;
        serde_json::from_slice(&b).map_err(|e| TErr::new(500, format!("bad json: {e}")))
    }
}
