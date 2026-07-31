#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod config;
mod mounts;
mod proxy;

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::Manager;

fn main() {
    // webkit2gtk's dmabuf renderer crashes some Wayland stacks outright
    // ("Error 71 (Protocol error) dispatching to Wayland display"). Opt out
    // there — but ONLY there: the fallback is software rendering, and paying
    // it on X11/XWayland sessions made the whole UI feel sluggish for nothing.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
        && std::env::var_os("WAYLAND_DISPLAY").is_some()
        && std::env::var_os("GDK_BACKEND").is_none_or(|b| b != "x11")
    {
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
        .manage(proxy::Bridge(Mutex::new(None)))
        .on_menu_event(|app, ev| {
            // the manager (connect + mounts) hides once the workspace is up —
            // this is its way back
            if ev.id().as_ref() == "manager" {
                if let Some(m) = app.get_webview_window("manager") {
                    m.show().ok();
                    m.set_focus().ok();
                }
            }
        })
        .setup(|app| {
            // one menu, one item: mounts lived in an unreachable window once
            // the manager auto-hid after connect
            let sub = tauri::menu::SubmenuBuilder::new(app, "lattice")
                .text("manager", "connection && mounts…")
                .build()?;
            app.set_menu(tauri::menu::MenuBuilder::new(app).items(&[&sub]).build()?)?;
            let handle = app.handle().clone();
            // LATTICE_AUTOCONNECT="url,+code": drive the real connect flow
            // without a display — the headless test harness's entry point.
            if let Ok(spec) = std::env::var("LATTICE_AUTOCONNECT") {
                if let Some((u, c)) = spec.split_once(',') {
                    let h = handle.clone();
                    let (u, c) = (u.to_string(), c.to_string());
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(3));
                        let r = tauri::async_runtime::block_on(commands::connect(h.clone(), u, c));
                        commands::dlog(&format!("autoconnect: {r:?}"));
                        // LATTICE_AUTONAV=/path: follow the connect with a
                        // fresh top-level navigation — the headless harness's
                        // regression check for the 403-on-navigation class
                        if let Ok(nav) = std::env::var("LATTICE_AUTONAV") {
                            std::thread::sleep(std::time::Duration::from_secs(8));
                            if let Some(w) = h.get_webview_window("workspace") {
                                if let Ok(cur) = w.url() {
                                    let t = format!("{}://{}:{}{nav}",
                                        cur.scheme(), cur.host_str().unwrap_or(""), cur.port().unwrap_or(80));
                                    commands::dlog(&format!("autonav: {t}"));
                                    w.navigate(t.parse().unwrap()).ok();
                                }
                            }
                        }
                    });
                }
            }
            let cfg = config::load(&handle);
            if !cfg.url.is_empty() {
                // off-thread: open_workspace polls the webview cookie jar,
                // which must not block the main loop
                let h = handle.clone();
                std::thread::spawn(move || {
                    commands::open_workspace(&h, false).ok();
                });
                let map = handle.state::<mounts::MountMap>();
                let mut m = map.0.lock().unwrap();
                for spec in &cfg.mounts {
                    mounts::heal_mountpoint(&spec.mountpoint);
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
