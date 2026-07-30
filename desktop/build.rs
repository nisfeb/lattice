fn main() {
    // pick_upload is the one command the ship-served workspace page may
    // invoke; listing it here generates its allow- permission for the
    // remote-upload capability. Unlisted commands stay local-only.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["pick_upload"])),
    )
    .expect("tauri-build failed")
}
