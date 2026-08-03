//! Installing %grubbery on the logged-in ship.
//!
//! Distribution is Ames, not git. %base has no HTTP client generator and no
//! git, so the only native install is `|install ~ship %desk` pulling the desk
//! from a publishing ship. %mcp wraps exactly that generator, so one tool call
//! starts it. (Grubbery does ship a real Hoon git client, but it is grubbery's
//! own code and so cannot be what installs grubbery.)
//!
//! `|install` returns immediately and the desk lands later, sometimes minutes
//! later, over Ames, on a pier that serializes. So the command pokes it and
//! then WATCHES, reporting as it goes. The honest completion signal is
//! grubbery answering its own route, not the poke being accepted.

use tauri::{AppHandle, Emitter};

/// the ship we publish %grubbery from. The user can point this anywhere
pub const DEFAULT_DISTRIBUTOR: &str = "~nisfeb";

/// how long to wait for the desk to arrive before giving up. Ames transfers of
/// a ~10MB desk over a slow link genuinely take minutes.
const WAIT_SECS: u64 = 600;

#[derive(Clone, serde::Serialize)]
pub struct Progress {
    /// one line for the log the user is watching
    pub line: String,
    /// running | ok | failed. Drives the status chip, not just the text
    pub state: String,
    /// seconds since the install started, so the UI can show it ticking
    pub secs: u64,
}

fn say(app: &AppHandle, t0: std::time::Instant, state: &str, line: impl Into<String>) {
    let p = Progress {
        line: line.into(),
        state: state.into(),
        secs: t0.elapsed().as_secs(),
    };
    crate::commands::dlog(&format!("install[{}] {}", p.state, p.line));
    // the manager page listens for these. A failure to emit must not abort the
    // install itself, so the result is deliberately dropped
    let _ = app.emit("install-progress", p);
}

/// Install %grubbery from `ship` (default ~nisfeb) onto the configured ship.
#[tauri::command]
pub async fn install_grubbery(app: AppHandle, ship: Option<String>) -> Result<String, String> {
    let t0 = std::time::Instant::now();
    let cfg = crate::config::load(&app);
    if cfg.url.is_empty() {
        return Err("connect to a ship first".into());
    }
    let from = ship
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_DISTRIBUTOR.to_string());
    // a bare @p is the only thing |install accepts. Catching it here beats a
    // hoon parse error surfacing as an opaque tool failure
    if !valid_ship(&from) {
        return Err(format!("{from} is not a ship name — try {DEFAULT_DISTRIBUTOR}"));
    }

    say(&app, t0, "running", format!("asking {} for %grubbery", from));
    let base = cfg.url.clone();
    let from2 = from.clone();
    let app2 = app.clone();

    // the blocking HTTP + poll loop must not sit on the async runtime's thread
    tauri::async_runtime::spawn_blocking(move || {
        let r = crate::stack::mcp_call(
            &base,
            "mcp/install-app",
            serde_json::json!({"ship": from2, "desk": "grubbery"}),
        );
        match r {
            Ok(v) => {
                if let Some(out) = v
                    .get("structuredContent")
                    .and_then(|s| s.get("dojo-output"))
                    .and_then(|s| s.as_str())
                {
                    for l in out.lines().filter(|l| !l.trim().is_empty()) {
                        say(&app2, t0, "running", l.trim().to_string());
                    }
                }
                say(&app2, t0, "running", "|install accepted — waiting for the desk to arrive");
            }
            Err(e) => {
                say(&app2, t0, "failed", e.clone());
                return Err(e);
            }
        }

        // |install is asynchronous. The poke returns long before the desk does.
        // Grubbery answering its own route is the only claim worth making.
        let mut last = String::new();
        loop {
            if t0.elapsed().as_secs() > WAIT_SECS {
                let msg = format!(
                    "%grubbery has not arrived after {}s — it may still be transferring; \
                     check |vats on the ship",
                    t0.elapsed().as_secs()
                );
                say(&app2, t0, "failed", msg.clone());
                return Err(msg);
            }
            std::thread::sleep(std::time::Duration::from_secs(5));
            let s = crate::stack::probe(&base);
            if s.grubbery {
                say(&app2, t0, "ok", "%grubbery is up and answering");
                return Ok("grubbery installed".to_string());
            }
            // only speak when something changed, so the log reads as progress
            // rather than a spinner printing the same line forever
            let now = match &s.error {
                Some(e) => format!("ship unreachable: {e}"),
                None => "still waiting for %grubbery".to_string(),
            };
            if now != last {
                say(&app2, t0, "running", now.clone());
                last = now;
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A shape check, not a full @p parse: enough to keep an obvious typo from
/// reaching the dojo, where it surfaces as an opaque tool failure. The ship
/// itself does the real validation.
fn valid_ship(s: &str) -> bool {
    let Some(body) = s.strip_prefix('~') else { return false };
    body.len() >= 3
        && body
            .chars()
            .all(|c| c.is_ascii_lowercase() || c == '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distributor_default_is_itself_valid() {
        // the default is what the prompt shows. If it were malformed every
        // first-run install would fail on our own validation
        assert!(valid_ship(DEFAULT_DISTRIBUTOR));
    }

    #[test]
    fn ship_names_are_shape_checked() {
        assert!(valid_ship("~nisfeb"));
        assert!(valid_ship("~ricsul-bilwyt"));
        assert!(valid_ship("~sampel-palnet-sampel-palnet"));
        assert!(!valid_ship("nisfeb"), "a missing ~ is the common typo");
        assert!(!valid_ship(""));
        assert!(!valid_ship("~"));
        assert!(!valid_ship("~ab"), "too short to be a @p");
        assert!(!valid_ship("~Nisfeb"), "@p is lowercase");
        assert!(!valid_ship("~nisfeb "), "trailing space would reach the dojo");
        assert!(!valid_ship("~nisfeb; |nuke %base"), "no command injection");
    }
}
