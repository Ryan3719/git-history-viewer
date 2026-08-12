use std::{
    fs,
    path::Path,
    process::{Command, Stdio},
    thread,
    time::Duration,
};

use tauri::State;

use crate::{
    models::{
        CommitDetails, ExternalDiffRequest, ExternalDiffSettings, FileChangesPage,
        FileChangesStatus, HistoryFilter, HistoryPage, RecentRepository, RepositoryInfo,
        RepositoryOpenRequest, SshRepositoryMapping,
    },
    AppState,
};

#[tauri::command]
pub async fn open_repository(
    state: State<'_, AppState>,
    repository: RepositoryOpenRequest,
) -> Result<RepositoryInfo, String> {
    let git = state.git.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if repository.is_file {
            let file = Path::new(&repository.path);
            let parent = file
                .parent()
                .ok_or_else(|| "所选文件路径无效。".to_string())?;
            let mut info = git.get_repository_info(
                parent.to_string_lossy().as_ref(),
                repository.path_scope.as_deref(),
                repository.path_scope_kind.as_deref(),
            )?;
            let file_name = file
                .file_name()
                .ok_or_else(|| "所选文件路径无效。".to_string())?
                .to_string_lossy();
            info.path_scope = Some(match info.path_scope {
                Some(scope) if !scope.is_empty() => format!("{scope}/{file_name}"),
                _ => file_name.into_owned(),
            });
            info.path_scope_kind = Some("file".into());
            return Ok(info);
        }
        git.get_repository_info(
            &repository.path,
            repository.path_scope.as_deref(),
            repository.path_scope_kind.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("打开仓库任务失败：{error}"))?
}

#[tauri::command]
pub fn list_recent_repositories(state: State<'_, AppState>) -> Vec<RecentRepository> {
    state.settings.recent_repositories()
}

#[tauri::command]
pub fn add_recent_repository(
    state: State<'_, AppState>,
    repository: RepositoryInfo,
) -> Result<Vec<RecentRepository>, String> {
    state.settings.add_recent_repository(repository)
}

#[tauri::command]
pub fn remove_recent_repository(
    state: State<'_, AppState>,
    repository: RepositoryOpenRequest,
) -> Result<Vec<RecentRepository>, String> {
    state.settings.remove_recent_repository(&repository)
}

#[tauri::command]
pub fn clear_recent_repositories(state: State<'_, AppState>) -> Result<(), String> {
    state.settings.clear_recent_repositories()
}

#[tauri::command]
pub async fn load_history(
    state: State<'_, AppState>,
    repository_path: String,
    path_scope: Option<String>,
    path_scope_kind: Option<String>,
    filter: HistoryFilter,
    offset: usize,
) -> Result<HistoryPage, String> {
    let git = state.git.clone();
    let generation = git.next_history_request();
    tauri::async_runtime::spawn_blocking(move || {
        git.list_commits(
            &repository_path,
            path_scope.as_deref(),
            path_scope_kind.as_deref(),
            &filter,
            offset,
            generation,
        )
    })
    .await
    .map_err(|error| format!("读取提交历史任务失败：{error}"))?
}

#[tauri::command]
pub fn cancel_history_requests(state: State<'_, AppState>) {
    state.git.cancel_requests();
}

#[tauri::command]
pub async fn get_commit_details(
    state: State<'_, AppState>,
    repository_path: String,
    hash: String,
) -> Result<CommitDetails, String> {
    let git = state.git.clone();
    let generation = git.next_details_request();
    tauri::async_runtime::spawn_blocking(move || {
        git.get_commit_details(&repository_path, &hash, generation)
    })
    .await
    .map_err(|error| format!("读取提交详情任务失败：{error}"))?
}

#[tauri::command]
pub fn start_file_changes_scan(
    state: State<'_, AppState>,
    repository_path: String,
    path_scope: Option<String>,
    hash: String,
) -> Result<FileChangesStatus, String> {
    state
        .git
        .start_file_changes_scan(repository_path, path_scope, hash)
}

#[tauri::command]
pub fn get_file_changes_status(
    state: State<'_, AppState>,
    repository_path: String,
    path_scope: Option<String>,
    hash: String,
) -> Result<FileChangesStatus, String> {
    state
        .git
        .get_file_changes_status(&repository_path, path_scope.as_deref(), &hash)
}

#[tauri::command]
pub async fn get_file_changes_page(
    state: State<'_, AppState>,
    repository_path: String,
    path_scope: Option<String>,
    hash: String,
    page: usize,
) -> Result<FileChangesPage, String> {
    let git = state.git.clone();
    tauri::async_runtime::spawn_blocking(move || {
        git.get_file_changes_page(&repository_path, path_scope.as_deref(), &hash, page)
    })
    .await
    .map_err(|error| format!("读取变更路径分页任务失败：{error}"))?
}

#[tauri::command]
pub async fn export_changed_paths(
    state: State<'_, AppState>,
    repository_path: String,
    hash: String,
    destination: String,
) -> Result<(), String> {
    let git = state.git.clone();
    tauri::async_runtime::spawn_blocking(move || {
        git.export_changed_paths(&repository_path, &hash, Path::new(&destination))
    })
    .await
    .map_err(|error| format!("导出变更路径任务失败：{error}"))?
}

#[tauri::command]
pub async fn clone_remote_repository(
    state: State<'_, AppState>,
    url: String,
    destination: String,
) -> Result<RepositoryInfo, String> {
    let git = state.git.clone();
    tauri::async_runtime::spawn_blocking(move || {
        git.clone_remote_repository(&url, Path::new(&destination))
    })
    .await
    .map_err(|error| format!("导入远程仓库任务失败：{error}"))?
}

#[tauri::command]
pub fn get_external_diff_settings(state: State<'_, AppState>) -> ExternalDiffSettings {
    state.settings.external_diff()
}

#[tauri::command]
pub fn save_external_diff_settings(
    state: State<'_, AppState>,
    settings: ExternalDiffSettings,
) -> Result<(), String> {
    state.settings.save_external_diff(settings)
}

#[tauri::command]
pub async fn open_external_diff(
    state: State<'_, AppState>,
    request: ExternalDiffRequest,
) -> Result<(), String> {
    if request.settings.command.trim().is_empty() {
        return Err("请先在设置中配置外部对比工具。".into());
    }
    let git = state.git.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let temporary = tempfile::Builder::new()
            .prefix("git-history-viewer-")
            .tempdir()
            .map_err(|error| format!("无法创建临时对比目录：{error}"))?;
        let extension = Path::new(&request.file.path)
            .extension()
            .map(|value| format!(".{}", value.to_string_lossy()))
            .unwrap_or_default();
        let file_name = Path::new(&request.file.path)
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| format!("comparison{extension}"));
        let left = temporary.path().join(format!("before-{file_name}"));
        let right = temporary.path().join(format!("after-{file_name}"));
        git.write_comparison_files(
            &request.repository_path,
            &request.commit_hash,
            request.parent_hash.as_deref(),
            &request.file,
            &left,
            &right,
        )?;
        let arguments = parse_arguments(
            &request.settings.arguments_template,
            &left,
            &right,
            &request.file.path,
        );
        Command::new(&request.settings.command)
            .args(arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("无法启动外部对比工具：{error}"))?;
        let directory = temporary.keep();
        thread::spawn(move || {
            thread::sleep(Duration::from_secs(60 * 60));
            let _ = fs::remove_dir_all(directory);
        });
        Ok(())
    })
    .await
    .map_err(|error| format!("启动外部对比任务失败：{error}"))?
}

#[tauri::command]
pub fn list_ssh_repository_mappings(state: State<'_, AppState>) -> Vec<SshRepositoryMapping> {
    state.settings.mappings()
}

#[tauri::command]
pub fn save_ssh_repository_mappings(
    state: State<'_, AppState>,
    mappings: Vec<SshRepositoryMapping>,
) -> Result<Vec<SshRepositoryMapping>, String> {
    let saved = state.settings.save_mappings(mappings)?;
    state.ssh.configure(saved.clone());
    Ok(saved)
}

#[tauri::command]
pub fn set_ssh_repository_password(
    state: State<'_, AppState>,
    mapping_id: String,
    password: String,
) -> Result<(), String> {
    state.settings.set_password(&mapping_id, &password)?;
    state.ssh.set_password(&mapping_id, password);
    Ok(())
}

#[tauri::command]
pub async fn test_ssh_repository_mapping(
    state: State<'_, AppState>,
    mut mapping: SshRepositoryMapping,
    password: Option<String>,
) -> Result<(), String> {
    mapping.id = mapping.id.trim().to_lowercase();
    mapping.host = mapping.host.trim().to_string();
    mapping.username = mapping.username.trim().to_string();
    if mapping.id.is_empty() || mapping.host.is_empty() || mapping.username.is_empty() {
        return Err("SSH 服务器配置不完整。请检查主机、用户名和端口。".into());
    }
    let ssh = state.ssh.clone();
    tauri::async_runtime::spawn_blocking(move || ssh.test(mapping, password))
        .await
        .map_err(|error| format!("SSH 测试任务失败：{error}"))?
}

#[tauri::command]
pub fn open_user_data_directory(state: State<'_, AppState>) -> Result<(), String> {
    let directory = state.settings.directory();
    fs::create_dir_all(directory).map_err(|error| format!("无法创建应用数据目录：{error}"))?;
    Command::new("explorer.exe")
        .arg(directory)
        .spawn()
        .map_err(|error| format!("无法打开应用数据目录：{error}"))?;
    Ok(())
}

fn parse_arguments(template: &str, left: &Path, right: &Path, file: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    for character in template.chars() {
        match (character, quote) {
            ('\'' | '"', None) => quote = Some(character),
            (value, Some(open)) if value == open => quote = None,
            (value, None) if value.is_whitespace() => {
                if !current.is_empty() {
                    result.push(current.clone());
                    current.clear();
                }
            }
            (value, _) => current.push(value),
        }
    }
    if !current.is_empty() {
        result.push(current);
    }
    let left = left.to_string_lossy();
    let right = right.to_string_lossy();
    result
        .into_iter()
        .map(|argument| {
            argument
                .replace("{left}", &left)
                .replace("{right}", &right)
                .replace("{file}", file)
        })
        .collect()
}
