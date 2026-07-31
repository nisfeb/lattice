//! What is actually installed on the ship we just logged in to.
//!
//! Three independent layers, detected by three different signatures because
//! they are three different kinds of thing:
//!
//!   %mcp       a DESK (agent %mcp-server) that binds eyre at /mcp. It is the
//!              bootstrap: with it we can drive a ship remotely, without it we
//!              can only tell the user to install it.
//!   %grubbery  a DESK whose agent serves /grubbery/… — the framework lattice
//!              runs inside.
//!   lattice    NOT a desk: an app folder in grubbery's ball, serving /apps/
//!              lattice. Committing its source installs nothing (see
//!              docs/grubbery-ops.md §1b), so the only honest test is whether
//!              the route answers.
//!
//! The discriminator for "not there" is 307. An unbound eyre path redirects to
//! /apps/landscape/, which the ops doc calls out as looking exactly like "the
//! app isn't installed" — here that IS what it means, but it means a 307 must
//! never be read as success.

use serde::Serialize;

/// eyre's redirect for a path nothing has bound
const UNBOUND: u16 = 307;

#[derive(Serialize, Default, Clone)]
pub struct Stack {
    pub mcp: bool,
    pub grubbery: bool,
    pub lattice: bool,
    /// serverInfo.name from the MCP handshake, e.g. "~tyr urbit mcp server".
    /// Present only when the handshake really succeeded.
    pub mcp_server: Option<String>,
    /// set when the ship could not be reached at all — very different from
    /// "reached it and nothing is installed", and must not read as the latter
    pub error: Option<String>,
}

/// A bound route answered. 307 means eyre had no binding; 404 likewise.
/// Anything else — including 403 and 406 — proves something is listening.
fn bound(status: u16) -> bool {
    status != UNBOUND && status != 404
}

fn cookie() -> Option<String> {
    std::fs::read_to_string(lattice_fs::default_cookie_path())
        .ok()
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
}

fn get_status(agent: &ureq::Agent, url: &str) -> Result<u16, String> {
    let mut req = agent.get(url);
    if let Some(c) = cookie() {
        req = req.set("cookie", &c);
    }
    match req.call() {
        Ok(r) => Ok(r.status()),
        Err(ureq::Error::Status(s, _)) => Ok(s),
        Err(e) => Err(e.to_string()),
    }
}

/// Real MCP `initialize` handshake, not just "something answered /mcp".
/// Returns serverInfo.name on success. The Accept header is required by the
/// MCP transport — without it the server answers 406 and a status-only probe
/// would call that "present" on the strength of an error.
fn mcp_handshake(agent: &ureq::Agent, base: &str) -> Option<String> {
    let mut req = agent
        .post(&format!("{base}/mcp"))
        .set("content-type", "application/json")
        .set("accept", "application/json, text/event-stream");
    if let Some(c) = cookie() {
        req = req.set("cookie", &c);
    }
    // ponytail: hand-rolled body string rather than enabling ureq's `json`
    // feature for one request — the payload is fixed and has nothing to escape.
    let body = format!(
        r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"protocolVersion":"2024-11-05","capabilities":{{}},"clientInfo":{{"name":"lattice-desktop","version":"{}"}}}}}}"#,
        env!("CARGO_PKG_VERSION")
    );
    let text = req.send_string(&body).ok()?.into_string().ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    Some(v.get("result")?.get("serverInfo")?.get("name")?.as_str()?.to_string())
}

pub fn probe(base: &str) -> Stack {
    let base = base.trim_end_matches('/');
    let agent = crate::proxy::agent();
    let mut out = Stack::default();

    // grubbery first: it is a plain GET and it tells us the ship is reachable
    match get_status(agent, &format!("{base}/grubbery/api/tree")) {
        Ok(s) => out.grubbery = bound(s),
        Err(e) => {
            out.error = Some(e);
            return out;
        }
    }
    if let Ok(s) = get_status(agent, &format!("{base}/apps/lattice")) {
        out.lattice = bound(s);
    }
    out.mcp_server = mcp_handshake(agent, base);
    out.mcp = out.mcp_server.is_some();
    out
}

#[tauri::command]
pub async fn stack_status(app: tauri::AppHandle) -> Stack {
    let cfg = crate::config::load(&app);
    if cfg.url.is_empty() {
        return Stack::default();
    }
    let s = probe(&cfg.url);
    crate::commands::dlog(&format!(
        "stack: mcp={} grubbery={} lattice={} server={:?} err={:?}",
        s.mcp, s.grubbery, s.lattice, s.mcp_server, s.error
    ));
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_real_binding_counts_as_installed() {
        // eyre's redirect for an unbound path is the exact failure the ops doc
        // warns reads as "installed" if you only check for a 2xx-or-error
        assert!(!bound(307), "307 is eyre saying nothing is bound here");
        assert!(!bound(404));
        // a bound route that refuses us is still a bound route
        assert!(bound(200));
        assert!(bound(403), "403 means it is there and we are not authorised");
        assert!(bound(406), "406 is the mcp server rejecting our Accept header");
        assert!(bound(405));
    }
}
