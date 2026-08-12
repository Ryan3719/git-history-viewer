mod commands;
mod git;
mod models;
mod settings;
mod ssh;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use git::GitService;
use models::RepositoryOpenRequest;
use settings::SettingsStore;
use ssh::SshManager;
use tauri::{Emitter, Manager};

pub struct AppState {
    settings: SettingsStore,
    ssh: Arc<SshManager>,
    git: Arc<GitService>,
    pending_repository: Mutex<Option<RepositoryOpenRequest>>,
    repository_listener_ready: AtomicBool,
}

fn parse_repository_request(arguments: &[String]) -> Option<RepositoryOpenRequest> {
    let mut index = 0;
    while index < arguments.len() {
        let argument = &arguments[index];
        if argument == "--repo" || argument == "--file" {
            let path = arguments.get(index + 1)?.trim();
            return (!path.is_empty()).then(|| RepositoryOpenRequest {
                path: path.into(),
                path_scope: None,
                path_scope_kind: None,
                is_file: argument == "--file",
            });
        }
        if let Some(path) = argument.strip_prefix("--repo=") {
            return (!path.trim().is_empty()).then(|| RepositoryOpenRequest {
                path: path.trim().into(),
                path_scope: None,
                path_scope_kind: None,
                is_file: false,
            });
        }
        if let Some(path) = argument.strip_prefix("--file=") {
            return (!path.trim().is_empty()).then(|| RepositoryOpenRequest {
                path: path.trim().into(),
                path_scope: None,
                path_scope_kind: None,
                is_file: true,
            });
        }
        index += 1;
    }
    None
}

fn forward_repository_request(app: &tauri::AppHandle, request: RepositoryOpenRequest) {
    let state = app.state::<AppState>();
    *state
        .pending_repository
        .lock()
        .expect("pending repository lock poisoned") = Some(request);
    if state.repository_listener_ready.load(Ordering::Acquire) {
        send_pending_repository(app);
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        if state.repository_listener_ready.load(Ordering::Acquire) {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

fn send_pending_repository(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let request = state
        .pending_repository
        .lock()
        .expect("pending repository lock poisoned")
        .take();
    if let Some(request) = request {
        let _ = app.emit("repository-open-requested", request);
    }
}

#[tauri::command]
fn repository_listener_ready(app: tauri::AppHandle, state: tauri::State<'_, AppState>) {
    state
        .repository_listener_ready
        .store(true, Ordering::Release);
    send_pending_repository(&app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn run() {
    let settings = SettingsStore::load().expect("无法加载应用设置");
    let mappings = settings.mappings();
    let passwords = settings.decrypted_passwords();
    let file_changes_directory = settings.file_changes_directory();
    let ssh = Arc::new(SshManager::new(mappings, passwords));
    let git = Arc::new(GitService::new(ssh.clone(), file_changes_directory));
    let initial_request = parse_repository_request(&std::env::args().collect::<Vec<_>>());
    let state = AppState {
        settings,
        ssh,
        git,
        pending_repository: Mutex::new(initial_request),
        repository_listener_ready: AtomicBool::new(false),
    };

    tauri::Builder::default()
        .manage(state)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(request) = parse_repository_request(&argv) {
                forward_repository_request(app, request);
            } else if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            repository_listener_ready,
            commands::open_repository,
            commands::list_recent_repositories,
            commands::add_recent_repository,
            commands::remove_recent_repository,
            commands::clear_recent_repositories,
            commands::load_history,
            commands::cancel_history_requests,
            commands::get_commit_details,
            commands::start_file_changes_scan,
            commands::get_file_changes_status,
            commands::get_file_changes_page,
            commands::export_changed_paths,
            commands::clone_remote_repository,
            commands::get_external_diff_settings,
            commands::save_external_diff_settings,
            commands::open_external_diff,
            commands::list_ssh_repository_mappings,
            commands::save_ssh_repository_mappings,
            commands::set_ssh_repository_password,
            commands::test_ssh_repository_mapping,
            commands::open_user_data_directory,
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window.state::<AppState>().ssh.close_all();
            }
        })
        .run(tauri::generate_context!())
        .expect("运行 Git History Viewer 失败");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_repository_arguments() {
        let request = parse_repository_request(&[
            "app.exe".into(),
            "--file".into(),
            r"C:\repo\file.txt".into(),
        ])
        .unwrap();
        assert!(request.is_file);
        assert_eq!(request.path, r"C:\repo\file.txt");
    }
}
