#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod config;
mod mounts;

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::Manager;

fn main() {
    // webkit2gtk's dmabuf renderer crashes some Wayland stacks outright
    // ("Error 71 (Protocol error) dispatching to Wayland display"). Opt out
    // unless the user has set it themselves.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|win, ev| match ev {
            // closing the manager while the workspace lives on used to orphan
            // the app (no way back to mounts/connect until relaunch) — hide it
            // instead. Closing it as the last window still exits normally.
            tauri::WindowEvent::CloseRequested { api, .. }
                if win.label() == "manager"
                    && win.app_handle().get_webview_window("workspace").is_some() =>
            {
                win.hide().ok();
                api.prevent_close();
            }
            // workspace gone -> bring the (possibly hidden) manager back, so
            // the app never runs on with zero visible windows
            tauri::WindowEvent::Destroyed if win.label() == "workspace" => {
                if let Some(m) = win.app_handle().get_webview_window("manager") {
                    m.show().ok();
                    m.set_focus().ok();
                }
            }
            _ => {}
        })
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
            commands::get_config,
            commands::pick_upload,
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
