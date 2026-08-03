//! What is actually installed on the ship we just logged in to.
//!
//! Three independent layers, detected by three different signatures because
//! they are three different kinds of thing:
//!
//!   %mcp       a DESK (agent %mcp-server) that binds eyre at /mcp. It is the
//!              bootstrap. With it we can drive a ship remotely, without it we
//!              can only tell the user to install it.
//!   %grubbery  a DESK whose agent serves /grubbery/…, the framework lattice
//!              runs inside.
//!   lattice    NOT a desk: an app folder in grubbery's ball, serving /apps/
//!              lattice. Committing its source installs nothing (see
//!              docs/grubbery-ops.md §1b), so the only honest test is whether
//!              the route answers.
//!
//! The discriminator for "not there" is 307. An unbound eyre path redirects to
//! /apps/landscape/, which the ops doc calls out as looking exactly like "the
//! app isn't installed". Here that IS what it means, but it means a 307 must
//! never be read as success.

use serde::Serialize;

/// eyre's redirect for a path nothing has bound
const UNBOUND: u16 = 307;

#[derive(Serialize, Default, Clone)]
pub struct Stack {
    /// did we actually ask the ship? All-false because nothing is connected is
    /// a different claim from all-false because nothing is installed, and the
    /// UI must not nag about missing software it never looked for.
    pub checked: bool,
    pub mcp: bool,
    pub grubbery: bool,
    pub lattice: bool,
    /// serverInfo.name from the MCP handshake, e.g. "~tyr urbit mcp server".
    /// Present only when the handshake really succeeded.
    pub mcp_server: Option<String>,
    /// set when the ship could not be reached at all, very different from
    /// "reached it and nothing is installed", and must not read as the latter
    pub error: Option<String>,
}

/// A bound route answered. 307 means eyre had no binding. 404 likewise.
/// Anything else (including 403 and 406) proves something is listening.
fn bound(status: u16) -> bool {
    status != UNBOUND && status != 404
}

/// One JSON-RPC tools/call against the ship's %mcp endpoint.
///
/// The transport answers as an SSE stream ("data: {json}") even for a single
/// reply, and it requires the Accept header. Without it the server 406s. A
/// tool that fails reports `isError` inside a 200, so the HTTP status alone
/// says nothing about whether the work happened.
pub fn mcp_call(base: &str, tool: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": tool, "arguments": args}
    })
    .to_string();
    let req = crate::proxy::with_cookie(
        crate::proxy::agent()
            .post(&format!("{}/mcp", base.trim_end_matches('/')))
            .set("content-type", "application/json")
            .set("accept", "application/json, text/event-stream"),
    );
    let text = match req.send_string(&body) {
        Ok(r) => r.into_string().map_err(|e| e.to_string())?,
        Err(ureq::Error::Status(s, _)) => {
            return Err(match s {
                403 => "the ship rejected our session — reconnect and try again".into(),
                404 | 307 => "this ship has no %mcp — install it first".into(),
                other => format!("%mcp returned HTTP {other}"),
            })
        }
        Err(e) => return Err(e.to_string()),
    };
    // the reply may arrive as a bare object or as one or more SSE data frames
    let frame = text
        .lines()
        .find_map(|l| l.strip_prefix("data: "))
        .unwrap_or(text.trim());
    let v: serde_json::Value =
        serde_json::from_str(frame).map_err(|e| format!("bad reply from %mcp: {e}"))?;
    if let Some(e) = v.get("error") {
        return Err(format!("%mcp: {e}"));
    }
    let result = v.get("result").cloned().unwrap_or(serde_json::Value::Null);
    if result.get("isError").and_then(|b| b.as_bool()) == Some(true) {
        return Err(format!(
            "%mcp {tool}: {}",
            result.get("content").map(|c| c.to_string()).unwrap_or_default()
        ));
    }
    Ok(result)
}

fn get_status(agent: &ureq::Agent, url: &str) -> Result<u16, String> {
    match crate::proxy::with_cookie(agent.get(url)).call() {
        Ok(r) => Ok(r.status()),
        Err(ureq::Error::Status(s, _)) => Ok(s),
        Err(e) => Err(e.to_string()),
    }
}

/// Real MCP `initialize` handshake, not just "something answered /mcp".
/// Returns serverInfo.name on success. The Accept header is required by the
/// MCP transport. Without it the server answers 406 and a status-only probe
/// would call that "present" on the strength of an error.
fn mcp_handshake(agent: &ureq::Agent, base: &str) -> Option<String> {
    let req = crate::proxy::with_cookie(
        agent
            .post(&format!("{base}/mcp"))
            .set("content-type", "application/json")
            .set("accept", "application/json, text/event-stream"),
    );
    // ponytail: hand-rolled body string rather than enabling ureq's `json`
    // feature for one request. The payload is fixed and has nothing to escape.
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
    let mut out = Stack { checked: true, ..Default::default() };

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
    // LATTICE_FAKESTACK=mcp|none|all: report a synthetic ship so the install
    // UI can be exercised without breaking a real one. Test hook only, same
    // family as the LATTICE_AUTO* hooks in main.rs.
    if let Ok(f) = std::env::var("LATTICE_FAKESTACK") {
        return Stack {
            checked: true,
            mcp: f != "none",
            grubbery: f == "all",
            lattice: f == "all",
            mcp_server: (f != "none").then(|| "~fake urbit mcp server".to_string()),
            error: None,
        };
    }
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

    use crate::testutil::Stub;

    #[test]
    fn the_probe_asks_the_ship_and_believes_only_what_it_answers() {
        // a ship with nothing installed: eyre 307s every unbound path
        let bare = Stub::new(|_| (307, String::new()));
        let s = probe(&bare.base);
        assert!(s.checked, "we DID ask: 'unknown' and 'nothing installed' are different claims");
        assert!(!s.grubbery && !s.lattice && !s.mcp, "307 is not an installation");
        assert!(s.mcp_server.is_none());
        assert!(s.error.is_none(), "a 307 is an answer, not a failure to reach the ship");
        assert_eq!(bare.got("/grubbery/api/tree").method, "GET");

        // a full stack, mcp proved by a real initialize handshake
        let full = Stub::new(|r| match r.target.as_str() {
            "/mcp" => (
                200,
                r#"{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"~stub urbit mcp server"}}}"#
                    .to_string(),
            ),
            _ => (200, "ok".to_string()),
        });
        let s = probe(&full.base);
        assert!(s.checked && s.grubbery && s.lattice && s.mcp, "a bound route is an installation");
        assert_eq!(s.mcp_server.as_deref(), Some("~stub urbit mcp server"));
        assert!(s.error.is_none());
        assert_eq!(full.got("/apps/lattice").method, "GET");

        // something answering /mcp is not the same as %mcp being there: a
        // status-only probe would call a 406 or a stray page "installed"
        let liar = Stub::new(|r| match r.target.as_str() {
            "/mcp" => (200, "not json at all".to_string()),
            _ => (200, "ok".to_string()),
        });
        let s = probe(&liar.base);
        assert!(!s.mcp && s.mcp_server.is_none(), "no handshake, no %mcp");

        // an unreachable ship must read as an error, NEVER as "nothing
        // installed". That would nag the user to reinstall a working ship
        let s = probe("http://127.0.0.1:1");
        assert!(s.checked, "we tried");
        assert!(s.error.is_some(), "unreachable must be reported as unreachable");
        assert!(!s.grubbery && !s.lattice && !s.mcp);
    }

    #[test]
    fn an_mcp_tool_failure_is_never_reported_as_success() {
        // the transport answers as SSE even for a single reply, and a tool
        // that failed reports isError INSIDE a 200. Reading the status alone
        // would tell the install UI the work happened when it did not.
        let failed = Stub::new(|_| {
            (200, "data: {\"result\":{\"isError\":true,\"content\":\"no such desk\"}}\n\n".to_string())
        });
        let e = mcp_call(&failed.base, "mcp/install-app", serde_json::json!({"desk": "grubbery"}))
            .unwrap_err();
        assert!(e.contains("no such desk"), "the ship's reason must survive: {e}");
        let sent = failed.only();
        assert_eq!(sent.target, "/mcp");
        assert_eq!(
            sent.header("accept"),
            Some("application/json, text/event-stream"),
            "without this header the mcp transport 406s"
        );
        assert!(sent.body_str().contains(r#""name":"mcp/install-app""#), "{}", sent.body_str());
        assert!(sent.body_str().contains(r#""desk":"grubbery""#), "arguments must be sent");

        // a good reply comes back as the result object itself
        let ok = Stub::new(|_| {
            (200, "data: {\"result\":{\"structuredContent\":{\"dojo-output\":\"done\"}}}\n".to_string())
        });
        let v = mcp_call(&ok.base, "t", serde_json::json!({})).unwrap();
        assert_eq!(v["structuredContent"]["dojo-output"], "done");

        // a ship with no %mcp gets an answer the user can act on
        let none = Stub::new(|_| (404, String::new()));
        let e = mcp_call(&none.base, "t", serde_json::json!({})).unwrap_err();
        assert!(e.contains("%mcp"), "{e}");
    }
}
