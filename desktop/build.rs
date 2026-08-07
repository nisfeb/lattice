fn main() {
    // Opting ANY command into the app manifest gates them ALL. An unlisted
    // command is denied everywhere ("connect not allowed"). So every command
    // is listed, local windows get all of them via capabilities/local.json,
    // and the ship-served workspace gets only pick_upload (workspace-remote).
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "connect",
            "local_ships",
            "stack_status",
            "install_grubbery",
            "connection_status",
            "get_config",
            "go_home",
            "pick_upload",
            "open_external_url",
            "status",
            "add_mount",
            "remove_mount",
            "list_mounts",
            // save_vault and pick_vault were missing from this list, and the
            // rule above is unforgiving: unlisted is denied EVERYWHERE. The
            // client calls both, so vault export and restore in the desktop
            // app failed with "not allowed. Command not found" — a feature
            // that looked implemented and could never once have run. Nothing
            // caught it because the browser tests take the download path and
            // never invoke at all.
            "save_vault",
            "pick_vault",
            // scheduled backups: the four config commands are manager-only
            // (capabilities/local.json), backup_write is the one the ship page
            // itself needs (capabilities/workspace-remote.json).
            "backup_schedules",
            "set_backup_schedules",
            "pick_backup_dir",
            "run_backup_now",
            "backup_write",
        ]),
    ))
    .expect("tauri-build failed")
}
