fn main() {
    // Opting ANY command into the app manifest gates them ALL — an unlisted
    // command is denied everywhere ("connect not allowed"). So every command
    // is listed, local windows get all of them via capabilities/local.json,
    // and the ship-served workspace gets only pick_upload (workspace-remote).
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "connect",
            "take_login",
            "get_config",
            "pick_upload",
            "status",
            "add_mount",
            "remove_mount",
            "list_mounts",
        ]),
    ))
    .expect("tauri-build failed")
}
