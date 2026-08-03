//! lattice-fs as a library: everything the desktop shell needs to auth,
//! build a projection over HTTP, and mount it in-process.

#[path = "core.rs"]
pub mod vfs;
pub mod eyre;
pub mod generic;
pub mod lattice;
pub mod lick;
pub mod projection;
pub mod transport;

use std::sync::Arc;

pub use eyre::EyreTransport;
pub use projection::Projection;
pub use transport::Transport;
pub use vfs::GrubberyFs;

/// Where to root the mounted tree. A value like `notes` or `page/notes` or the
/// full ball path `/apps/lattice.lattice_app/page/notes` mounts a lattice
/// sub-tree (keeps all page semantics). Any other absolute ball path
/// (`/apps/obelisk.obelisk_app`, …) is a generic tree, a different nexus.
pub enum Root {
    Lattice(String), // sub-root under /page ("" = whole tree)
    Generic(String), // full ball path
}

pub fn resolve_root(val: &str) -> Root {
    let v = val.trim();
    if v.is_empty() {
        return Root::Lattice(String::new());
    }
    if let Some(rest) = v.strip_prefix("/apps/lattice.lattice_app/page") {
        return Root::Lattice(rest.trim_matches('/').to_string());
    }
    if v.starts_with('/') {
        return Root::Generic(v.trim_matches('/').to_string());
    }
    let rel = v.trim_matches('/');
    Root::Lattice(rel.strip_prefix("page/").unwrap_or(rel).to_string())
}

pub fn default_cookie_path() -> String {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    format!("{home}/.config/lattice-fs/cookie")
}

/// Build a projection over the Eyre (HTTP) transport only, the desktop
/// shell's path. The CLI keeps its lick branch in main.rs.
pub fn projection_http(
    url: &str,
    cookie_path: &str,
    root: &str,
) -> Result<Arc<dyn Projection>, String> {
    let t = Box::new(EyreTransport::new(url, cookie_path));
    match resolve_root(root) {
        Root::Lattice(sub) => {
            Ok(Arc::new(lattice::LatticeProjection::new(t, &sub).map_err(|e| e.msg)?))
        }
        Root::Generic(path) => {
            Ok(Arc::new(generic::GenericProjection::new(t, &path).map_err(|e| e.msg)?))
        }
    }
}

/// Build a projection over the lick (unix-socket) transport, a ship running
/// on THIS machine. No cookie and no +code: the socket lives inside the pier,
/// so being able to open it is the authorization.
///
/// Lattice roots only. The generic ball API is HTTP-only (it is not served on
/// the fs.sig lick port), so a generic root is refused here rather than
/// mounting something that would fail on every read.
pub fn projection_lick(
    sock_path: &str,
    our: &str,
    root: &str,
) -> Result<Arc<dyn Projection>, String> {
    match resolve_root(root) {
        Root::Lattice(sub) => {
            let t = Box::new(lick::LickTransport::new(sock_path, our));
            Ok(Arc::new(lattice::LatticeProjection::new(t, &sub).map_err(|e| e.msg)?))
        }
        Root::Generic(path) => Err(format!(
            "/{path} is a generic ball path, which is only served over HTTP — \
             mount a lattice page root over lick, or connect to this ship by URL"
        )),
    }
}

/// The one mount Config both the CLI and the shell use: kernel-enforced
/// perms from the uid/gid/mode we report, owner-only ACL.
pub fn mount_config() -> fuser::Config {
    let mut config = fuser::Config::default();
    config.mount_options = vec![
        fuser::MountOption::FSName("lattice".to_string()),
        fuser::MountOption::DefaultPermissions,
    ];
    config.acl = fuser::SessionACL::Owner;
    config
}

/// Background mount: returns a handle. Dropping it unmounts.
pub fn spawn(
    proj: Arc<dyn Projection>,
    mnt: &str,
) -> std::io::Result<fuser::BackgroundSession> {
    std::fs::create_dir_all(mnt).ok();
    fuser::spawn_mount(GrubberyFs::new(proj), mnt, &mount_config())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_root_variants() {
        assert!(matches!(resolve_root(""), Root::Lattice(s) if s.is_empty()));
        assert!(matches!(resolve_root("notes"), Root::Lattice(s) if s == "notes"));
        assert!(matches!(resolve_root("page/notes"), Root::Lattice(s) if s == "notes"));
        assert!(matches!(
            resolve_root("/apps/lattice.lattice_app/page/notes"),
            Root::Lattice(s) if s == "notes"
        ));
        assert!(matches!(
            resolve_root("/apps/foo.foo_app"),
            Root::Generic(s) if s == "apps/foo.foo_app"
        ));
    }

    #[test]
    fn the_mount_is_owner_only_with_kernel_enforced_permissions() {
        let c = mount_config();
        assert_eq!(c.acl, fuser::SessionACL::Owner, "no other uid may reach the mount");
        assert!(
            c.mount_options.contains(&fuser::MountOption::DefaultPermissions),
            "without this the kernel ignores the 0o444 we report for generated pages"
        );
        assert!(c.mount_options.contains(&fuser::MountOption::FSName("lattice".to_string())));
    }

    #[test]
    fn the_cookie_lives_under_the_users_config_dir() {
        // a relative path would drop a live session cookie into whatever
        // directory the process happened to start in
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        assert_eq!(default_cookie_path(), format!("{home}/.config/lattice-fs/cookie"));
    }

    use proptest::prelude::*;

    proptest! {
        // total over anything a config file or CLI can hand it, and the
        // resolved root is always normalized (no leading/trailing slashes),
        // which the projections' path building depends on
        #[test]
        fn resolve_root_is_total_and_normalized(val in ".*") {
            let s = match resolve_root(&val) {
                Root::Lattice(s) => s,
                Root::Generic(s) => s,
            };
            prop_assert!(!s.starts_with('/'), "{:?} kept a leading slash", s);
            prop_assert!(!s.ends_with('/'), "{:?} kept a trailing slash", s);
        }
    }
}
