#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod config;
mod mounts;

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .manage(commands::PendingLogin(Mutex::new(None)))
        .manage(mounts::MountMap(Mutex::new(HashMap::new())))
        .setup(|app| {
            let handle = app.handle().clone();
            let cfg = config::load(&handle);
            if !cfg.url.is_empty() {
                // login.html's no-pending branch navigates straight to the ship
                commands::open_workspace(&handle).ok();
                let map = handle.state::<mounts::MountMap>();
                let mut m = map.0.lock().unwrap();
                for spec in &cfg.mounts {
                    match lattice_fs::projection_http(
                        &cfg.url,
                        &lattice_fs::default_cookie_path(),
                        &spec.root,
                    )
                    .and_then(|p| lattice_fs::spawn(p, &spec.mountpoint).map_err(|e| e.to_string()))
                    {
                        Ok(s) => {
                            m.insert(spec.mountpoint.clone(), (spec.root.clone(), s));
                        }
                        Err(e) => eprintln!("remount {} failed: {e}", spec.mountpoint),
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connect,
            commands::take_login,
            commands::get_config,
            mounts::status,
            mounts::add_mount,
            mounts::remove_mount,
            mounts::list_mounts,
        ])
        .build(tauri::generate_context!())
        .expect("error building lattice desktop")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // drop every BackgroundSession -> clean unmounts before the
                // process dies (drops of managed state are not otherwise run).
                app.state::<mounts::MountMap>().0.lock().unwrap().clear();
            }
        });
}
