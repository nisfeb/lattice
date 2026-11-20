//! System notifications, raised by the notifier each system already
//! has: `notify-send` on Linux (or the session bus by `gdbus`), the
//! script runner on a Mac, PowerShell on Windows. Rune has no call for
//! one. A notification is a title and a body, and nothing else: no
//! icon of its own, no sound, no action, and a press on it does nothing
//! here. The words reach the notifier as arguments or in the
//! environment, never inside a script's text.

/// A new share, as the ship's `/beacon/shares` stamp tells it.
#[derive(Clone, Debug, PartialEq)]
pub struct Share {
    /// What tells this telling from another: who, what and when.
    pub key: String,
    pub title: String,
    pub body: String,
}

/// How long a notification's title and body may be, in characters, as the desktop app has them.
const TITLE_MAX: usize = 120;
const BODY_MAX: usize = 200;

/// A notification's text: no control characters, and `max` characters at most.
pub fn text(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control()).take(max).collect()
}

/// The notification a share stamp asks for: only an `add`, a page or a
/// folder new to what is shared with this ship. A mode changed, a share
/// told again and one taken back raise none, as in the web client
/// (`ui-src/lattice/73r-access.js`).
pub fn share(stamp: &str) -> Option<Share> {
    let v: serde_json::Value = serde_json::from_str(stamp).ok()?;
    let word = |k: &str| v.get(k).and_then(serde_json::Value::as_str).filter(|s| !s.is_empty());
    let (host, path) = (word("host")?, word("path")?);
    if word("op") != Some("add") {
        return None;
    }
    let kind = if crate::swm::is_dir(path) { "A folder" } else { "A page" };
    Some(Share {
        key: format!("{host} {path} {}", word("t").unwrap_or_default()),
        title: text(&format!("{host} shared {} with you", crate::swm::name(path)), TITLE_MAX),
        body: format!("{kind}, in shared with me"),
    })
}

/// Takes a telling's key, and says whether it is new. The last fifty are held.
pub fn once(seen: &mut Vec<String>, key: &str) -> bool {
    if seen.iter().any(|k| k == key) {
        return false;
    }
    seen.push(key.to_owned());
    if seen.len() > 50 {
        seen.remove(0);
    }
    true
}

/// A notifier to run: the program, its arguments, and what it reads from its environment.
#[cfg(not(target_arch = "wasm32"))]
type Run = (&'static str, Vec<String>, Vec<(&'static str, String)>);

/// The notifiers of this system, in the order they are tried.
#[cfg(not(target_arch = "wasm32"))]
fn notifiers(title: &str, body: &str) -> Vec<Run> {
    let (title, body) = (text(title, TITLE_MAX), text(body, BODY_MAX));
    if cfg!(target_os = "macos") {
        // the words are the script's arguments, so nothing in them is read as script
        let script = ["on run argv", "display notification (item 2 of argv) with title (item 1 of argv)", "end run"];
        let mut args: Vec<String> = script.iter().flat_map(|l| ["-e".to_owned(), (*l).to_owned()]).collect();
        args.extend([title, body]);
        vec![("osascript", args, Vec::new())]
    } else if cfg!(windows) {
        // a toast, with the words read from the environment
        let script = "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; \
            $x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); \
            $t = $x.GetElementsByTagName('text'); \
            $t.Item(0).AppendChild($x.CreateTextNode($env:LATTICE_NOTE_TITLE)) | Out-Null; \
            $t.Item(1).AppendChild($x.CreateTextNode($env:LATTICE_NOTE_BODY)) | Out-Null; \
            [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('lattice').Show([Windows.UI.Notifications.ToastNotification]::new($x))";
        vec![("powershell", ["-NoProfile", "-NonInteractive", "-Command", script].map(str::to_owned).to_vec(), vec![("LATTICE_NOTE_TITLE", title), ("LATTICE_NOTE_BODY", body)])]
    } else {
        // a leading dash in the words is not an option: they come after `--`
        let send = ["--app-name=lattice", "--icon=lattice-rune", "--", &title, &body].map(str::to_owned).to_vec();
        // the same call over the session bus, where there is no notify-send. Its last argument is -1, which is an option unless it follows `--`
        let bus = ["call", "--session", "--dest", "org.freedesktop.Notifications", "--object-path", "/org/freedesktop/Notifications", "--method", "org.freedesktop.Notifications.Notify", "--", "lattice", "0", "lattice-rune"]
            .map(str::to_owned)
            .into_iter()
            .chain([gvariant(&title), gvariant(&body), "[]".to_owned(), "{}".to_owned(), "-1".to_owned()])
            .collect();
        vec![("notify-send", send, Vec::new()), ("gdbus", bus, Vec::new())]
    }
}

/// A text as `gdbus` reads a string argument: quoted, with its quotes and backslashes escaped.
#[cfg(not(target_arch = "wasm32"))]
fn gvariant(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Raises a system notification, on a thread of its own: the first of
/// this system's notifiers that runs. One that cannot be raised is not
/// said, since the app's own line says the same thing. A debug build
/// runs the program `LATTICE_NOTIFIER` names in their place, with the
/// title and the body as its two arguments, for a check with no desktop.
pub fn show(title: &str, body: &str) {
    #[cfg(target_arch = "wasm32")]
    let _ = (title, body);
    #[cfg(not(target_arch = "wasm32"))]
    {
        let mut all = notifiers(title, body);
        let test = if cfg!(debug_assertions) { std::env::var("LATTICE_NOTIFIER").ok().filter(|p| !p.is_empty()) } else { None };
        std::thread::spawn(move || {
            if let Some(p) = test {
                let (_, args, _) = all.remove(0);
                let _ = std::process::Command::new(p).args(&args[args.len() - 2..]).status();
                return;
            }
            for (program, args, env) in all {
                let mut cmd = std::process::Command::new(program);
                cmd.args(args).envs(env).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
                #[cfg(windows)]
                {
                    // no console window flashed up for it
                    use std::os::windows::process::CommandExt;
                    cmd.creation_flags(0x0800_0000);
                }
                if cmd.status().is_ok_and(|s| s.success()) {
                    return;
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_new_share_is_a_notification() {
        let stamp = |op: &str, path: &str| format!(r#"{{"t":"~2026.11.19..10.00.00","op":"{op}","host":"~sampel-palnet","path":"{path}","rev":7}}"#);
        let page = share(&stamp("add", "/lattice/page/notes/plan/code")).unwrap();
        assert_eq!((page.title.as_str(), page.body.as_str()), ("~sampel-palnet shared notes/plan with you", "A page, in shared with me"));
        assert_eq!(page.key, "~sampel-palnet /lattice/page/notes/plan/code ~2026.11.19..10.00.00");
        let folder = share(&stamp("add", "/lattice/page/notes/dir-index")).unwrap();
        assert_eq!((folder.title.as_str(), folder.body.as_str()), ("~sampel-palnet shared notes/ with you", "A folder, in shared with me"));
        for op in ["mode", "touch", "del"] {
            assert_eq!(share(&stamp(op, "/lattice/page/notes/plan/code")), None, "{op} raises none");
        }
        assert_eq!((share(""), share("42"), share(r#"{"op":"add","host":"~zod"}"#)), (None, None, None));
    }

    #[test]
    fn a_telling_is_taken_once_and_the_words_are_cleaned() {
        let mut seen = Vec::new();
        assert!(once(&mut seen, "a"));
        assert!(!once(&mut seen, "a"));
        for i in 0..60 {
            once(&mut seen, &i.to_string());
        }
        assert_eq!(seen.len(), 50);
        assert_eq!(text("a\u{7}b\nc\u{1b}[31m", 4), "abc[");
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn the_words_reach_a_notifier_as_words_alone() {
        let all = notifiers("--urgency=critical \"x\"", "$(reboot) `y`\n");
        for (_, args, env) in &all {
            let said: Vec<&String> = args.iter().chain(env.iter().map(|(_, v)| v)).collect();
            assert!(said.iter().any(|a| a.contains("--urgency=critical")), "the title is passed whole");
            assert!(said.iter().all(|a| !a.contains('\n')), "no control characters");
        }
        if cfg!(all(unix, not(target_os = "macos"))) {
            let (program, args, _) = &all[0];
            assert_eq!(*program, "notify-send");
            let dashes = args.iter().position(|a| a == "--").unwrap();
            assert_eq!(args.len(), dashes + 3, "the title and the body follow `--`, so neither is an option");
            assert_eq!(gvariant("a\"b\\c"), "\"a\\\"b\\\\c\"");
            let (program, args, _) = &all[1];
            assert_eq!(*program, "gdbus");
            let dashes = args.iter().position(|a| a == "--").unwrap();
            assert_eq!((args.len(), args.last().map(String::as_str)), (dashes + 9, Some("-1")), "the eight arguments of Notify follow `--`");
        }
    }
}
