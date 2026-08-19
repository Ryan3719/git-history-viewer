use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime},
};

use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;
use wait_timeout::ChildExt;

use crate::{
    models::{
        CommitDetails, CommitSummary, FileChange, FileChangesPage, FileChangesStatus,
        HistoryFilter, HistoryPage, RepositoryInfo, SshRepositoryMapping,
    },
    ssh::SshManager,
};

const FIELD_SEPARATOR: char = '\u{001f}';
const RECORD_SEPARATOR: char = '\u{001e}';
const FILE_CHANGES_PAGE_SIZE: usize = 200;
const INITIAL_FILE_CHANGES_AVAILABLE: usize = 50;
const MAX_RENAME_CANDIDATES: usize = 2_000;
const MAX_OUTPUT_BYTES: usize = 32 * 1024 * 1024;
const HISTORY_SEARCH_BATCH_SIZE: usize = 100;
const MAX_MEMORY_FILE_CHANGES: usize = 32;
const MAX_PERSISTED_FILE_CHANGES: usize = 256;
const MAX_PERSISTED_FILE_CHANGES_BYTES: u64 = 256 * 1024 * 1024;
const MAX_PERSISTED_FILE_CHANGES_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const GIT_COMMAND_TIMEOUT: Duration = Duration::from_secs(2 * 60);
const GIT_CLONE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const SSH_HOME_MARKER: &str = "__git_history_viewer_home__";
const FILE_CHANGES_CACHE_VERSION: u32 = 3;
const COMMIT_FORMAT: &str = "%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1f%D";
const SEARCH_COMMIT_FORMAT: &str = "%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%D%x1f%B";

#[derive(Clone)]
struct SshLocation {
    mapping: SshRepositoryMapping,
    remote_path: String,
    uses_home_directory: bool,
}

#[derive(Clone)]
struct NetworkLocation {
    host: String,
    relative_path: String,
}

#[derive(Default)]
struct FileChangesData {
    changes: Vec<FileChange>,
    complete: bool,
    error: Option<String>,
}

struct FileChangesCache {
    data: Mutex<FileChangesData>,
    progress: Condvar,
}

struct FileChangesCacheEntry {
    cache: Arc<FileChangesCache>,
    last_access: u64,
}

struct HistorySearchRecord {
    commit: CommitSummary,
    message: String,
    paths: Vec<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedFileChanges {
    version: u32,
    repository_path: String,
    path_scope: String,
    hash: String,
    changes: Vec<FileChange>,
}

impl FileChangesCache {
    fn status(&self) -> FileChangesStatus {
        let data = self.data.lock().expect("file changes cache lock poisoned");
        FileChangesStatus {
            scanned_count: data.changes.len(),
            available_count: data.changes.len(),
            complete: data.complete,
        }
    }
}

pub struct GitService {
    ssh: Arc<SshManager>,
    file_changes_cache_directory: PathBuf,
    file_changes: Mutex<HashMap<String, FileChangesCacheEntry>>,
    file_changes_access: AtomicU64,
    history_generation: AtomicU64,
    details_generation: AtomicU64,
    file_changes_generation: AtomicU64,
}

impl GitService {
    pub fn new(ssh: Arc<SshManager>, file_changes_cache_directory: PathBuf) -> Self {
        let _ = fs::create_dir_all(&file_changes_cache_directory);
        cleanup_persisted_file_changes(&file_changes_cache_directory);
        Self {
            ssh,
            file_changes_cache_directory,
            file_changes: Mutex::new(HashMap::new()),
            file_changes_access: AtomicU64::new(0),
            history_generation: AtomicU64::new(0),
            details_generation: AtomicU64::new(0),
            file_changes_generation: AtomicU64::new(0),
        }
    }

    pub fn next_history_request(&self) -> u64 {
        self.history_generation.fetch_add(1, Ordering::AcqRel) + 1
    }

    pub fn next_details_request(&self) -> u64 {
        self.details_generation.fetch_add(1, Ordering::AcqRel) + 1
    }

    pub fn cancel_requests(&self) {
        self.history_generation.fetch_add(1, Ordering::AcqRel);
        self.details_generation.fetch_add(1, Ordering::AcqRel);
        self.file_changes_generation.fetch_add(1, Ordering::AcqRel);
    }

    pub fn get_repository_info(
        &self,
        repository_path: &str,
        requested_path_scope: Option<&str>,
        requested_path_scope_kind: Option<&str>,
    ) -> Result<RepositoryInfo, String> {
        let resolved_path = self.resolve_repository_path(repository_path)?;
        let raw = self
            .run_git(
                Some(&resolved_path),
                &[
                    "rev-parse".into(),
                    "--show-toplevel".into(),
                    "--show-prefix".into(),
                ],
                MAX_OUTPUT_BYTES,
                || false,
                GIT_COMMAND_TIMEOUT,
            )
            .map_err(|error| {
                if error.to_lowercase().contains("not a git repository") {
                    "不是 Git 仓库。".to_string()
                } else {
                    error
                }
            })?;
        let text = String::from_utf8_lossy(&raw);
        let mut lines = text.lines();
        let root = lines.next().unwrap_or_default().trim().to_string();
        if root.is_empty() {
            return Err("不是 Git 仓库。".into());
        }
        let selected_scope = lines.next().unwrap_or_default();
        let path_scope = normalize_path_scope(requested_path_scope.unwrap_or(selected_scope))?;
        let ssh_location = self.parse_ssh_location(&resolved_path)?;
        let canonical_path = ssh_location
            .as_ref()
            .map(|location| create_ssh_path(&location.mapping.id, &root))
            .transpose()?
            .unwrap_or_else(|| root.clone());
        let branch = self
            .try_git_text(
                Some(&canonical_path),
                &["branch".into(), "--show-current".into()],
            )
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "DETACHED".into());
        let head = self
            .try_git_text(
                Some(&canonical_path),
                &["rev-parse".into(), "--short".into(), "HEAD".into()],
            )
            .unwrap_or_default();
        let name = root
            .trim_end_matches(['/', '\\'])
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(&root)
            .to_string();
        Ok(RepositoryInfo {
            path: canonical_path,
            display_path: ssh_location.map(|location| {
                format!(
                    "{}@{}:{}",
                    location.mapping.username, location.mapping.host, root
                )
            }),
            path_scope: (!path_scope.is_empty()).then_some(path_scope),
            path_scope_kind: (!requested_path_scope
                .unwrap_or(selected_scope)
                .trim()
                .is_empty())
            .then(|| requested_path_scope_kind.unwrap_or("directory").to_string()),
            name,
            branch,
            head,
        })
    }

    pub fn list_commits(
        &self,
        repository_path: &str,
        path_scope: Option<&str>,
        _path_scope_kind: Option<&str>,
        filter: &HistoryFilter,
        offset: usize,
        request_generation: u64,
    ) -> Result<HistoryPage, String> {
        let query = filter.query.trim();
        let page_limit = filter.limit.max(1);
        let scope = normalize_path_scope(path_scope.unwrap_or_default())?;
        if !query.is_empty() {
            return self.search_commits(
                repository_path,
                &scope,
                filter,
                offset,
                page_limit,
                request_generation,
            );
        }
        let mut args = vec![
            "log".into(),
            "--all".into(),
            "--date=iso-strict".into(),
            format!("--max-count={}", page_limit + 1),
            format!("--format={COMMIT_FORMAT}"),
        ];
        append_date_filter(&mut args, filter);
        if offset > 0 {
            args.push(format!("--skip={offset}"));
        }
        if !scope.is_empty() {
            args.push("--".into());
            args.push(scope.clone());
        }

        let output = String::from_utf8_lossy(&self.run_git(
            Some(repository_path),
            &args,
            MAX_OUTPUT_BYTES,
            || self.history_generation.load(Ordering::Acquire) != request_generation,
            GIT_COMMAND_TIMEOUT,
        )?)
        .into_owned();
        let mut commits = parse_commit_records(&output);
        let has_more = commits.len() > page_limit;
        commits.truncate(page_limit);
        let next_offset = offset + commits.len();
        Ok(HistoryPage {
            commits,
            has_more,
            next_offset,
        })
    }

    fn search_commits(
        &self,
        repository_path: &str,
        path_scope: &str,
        filter: &HistoryFilter,
        offset: usize,
        page_limit: usize,
        request_generation: u64,
    ) -> Result<HistoryPage, String> {
        let needle = filter.query.trim().to_lowercase();
        let mut scan_offset = offset;
        let mut commits = Vec::with_capacity(page_limit);
        let deadline = Instant::now() + GIT_COMMAND_TIMEOUT;

        loop {
            let mut args = vec![
                "log".into(),
                "--all".into(),
                "--date=iso-strict".into(),
                "--name-only".into(),
                "-z".into(),
                format!("--max-count={HISTORY_SEARCH_BATCH_SIZE}"),
                format!("--skip={scan_offset}"),
                format!("--format={SEARCH_COMMIT_FORMAT}"),
            ];
            append_date_filter(&mut args, filter);
            if !path_scope.is_empty() {
                args.push("--".into());
                args.push(path_scope.into());
            }

            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("Git 历史搜索超时。请缩小日期或路径范围后重试。".into());
            }
            let output = String::from_utf8_lossy(&self.run_git(
                Some(repository_path),
                &args,
                MAX_OUTPUT_BYTES,
                || self.history_generation.load(Ordering::Acquire) != request_generation,
                remaining,
            )?)
            .into_owned();
            let records = parse_history_search_records(&output);
            let scanned = records.len();
            for record in records {
                if history_record_matches(&record, &filter.scope, &needle) {
                    if commits.len() == page_limit {
                        return Ok(HistoryPage {
                            commits,
                            has_more: true,
                            next_offset: scan_offset,
                        });
                    }
                    commits.push(record.commit);
                }
                scan_offset += 1;
            }
            if scanned < HISTORY_SEARCH_BATCH_SIZE {
                return Ok(HistoryPage {
                    commits,
                    has_more: false,
                    next_offset: scan_offset,
                });
            }
        }
    }

    pub fn get_commit_details(
        &self,
        repository_path: &str,
        hash: &str,
        request_generation: u64,
    ) -> Result<CommitDetails, String> {
        let output = self.run_git(
            Some(repository_path),
            &[
                "show".into(),
                "-s".into(),
                "--format=%H%x1f%P".into(),
                hash.into(),
            ],
            MAX_OUTPUT_BYTES,
            || self.details_generation.load(Ordering::Acquire) != request_generation,
            GIT_COMMAND_TIMEOUT,
        )?;
        let text = String::from_utf8_lossy(&output);
        let mut values = text.trim().split(FIELD_SEPARATOR);
        let hash = values.next().unwrap_or_default().to_string();
        let parents = values
            .next()
            .unwrap_or_default()
            .split_whitespace()
            .map(str::to_string)
            .collect();
        Ok(CommitDetails { hash, parents })
    }

    pub fn start_file_changes_scan(
        self: &Arc<Self>,
        repository_path: String,
        path_scope: Option<String>,
        hash: String,
    ) -> Result<FileChangesStatus, String> {
        let generation = self.file_changes_generation.fetch_add(1, Ordering::AcqRel) + 1;
        let scope = normalize_path_scope(path_scope.as_deref().unwrap_or_default())?;
        let key = file_changes_key(&repository_path, &scope, &hash);
        if let Some(cache) = self.cached_file_changes(&key) {
            return Ok(cache.status());
        }
        let cache = Arc::new(FileChangesCache {
            data: Mutex::new(FileChangesData::default()),
            progress: Condvar::new(),
        });
        if let Some(changes) = self.load_persisted_file_changes(&repository_path, &scope, &hash) {
            {
                let mut data = cache.data.lock().expect("file changes cache lock poisoned");
                data.changes = changes;
                data.complete = true;
            }
            self.insert_file_changes_cache(key, cache.clone());
            return Ok(cache.status());
        }
        self.insert_file_changes_cache(key.clone(), cache.clone());
        let service = self.clone();
        let worker_cache = cache.clone();
        let worker_key = key.clone();
        thread::spawn(move || {
            let result = service.scan_file_changes(
                &repository_path,
                &scope,
                &hash,
                &worker_cache,
                generation,
            );
            let mut data = worker_cache
                .data
                .lock()
                .expect("file changes cache lock poisoned");
            match result {
                Ok(()) => {
                    data.complete = true;
                    let changes = data.changes.clone();
                    drop(data);
                    service.persist_file_changes(&repository_path, &scope, &hash, &changes);
                    worker_cache.progress.notify_all();
                    service.trim_file_changes_memory();
                }
                Err(error) => {
                    data.error = Some(error);
                    drop(data);
                    worker_cache.progress.notify_all();
                    let mut caches = service
                        .file_changes
                        .lock()
                        .expect("file changes map lock poisoned");
                    if caches
                        .get(&worker_key)
                        .is_some_and(|entry| Arc::ptr_eq(&entry.cache, &worker_cache))
                    {
                        caches.remove(&worker_key);
                    }
                }
            }
        });
        Ok(cache.status())
    }

    pub fn get_file_changes_status(
        &self,
        repository_path: &str,
        path_scope: Option<&str>,
        hash: &str,
    ) -> Result<FileChangesStatus, String> {
        let scope = normalize_path_scope(path_scope.unwrap_or_default())?;
        let cache = self.file_changes_cache(repository_path, &scope, hash)?;
        let data = cache.data.lock().expect("file changes cache lock poisoned");
        if let Some(error) = &data.error {
            return Err(error.clone());
        }
        Ok(FileChangesStatus {
            scanned_count: data.changes.len(),
            available_count: data.changes.len(),
            complete: data.complete,
        })
    }

    pub fn get_file_changes_page(
        &self,
        repository_path: &str,
        path_scope: Option<&str>,
        hash: &str,
        page: usize,
    ) -> Result<FileChangesPage, String> {
        let scope = normalize_path_scope(path_scope.unwrap_or_default())?;
        let cache = self.file_changes_cache(repository_path, &scope, hash)?;
        let start = page.saturating_mul(FILE_CHANGES_PAGE_SIZE);
        let mut data = cache.data.lock().expect("file changes cache lock poisoned");
        while !data.complete && data.error.is_none() && start >= data.changes.len() {
            data = cache
                .progress
                .wait(data)
                .expect("file changes cache lock poisoned");
        }
        if let Some(error) = &data.error {
            return Err(error.clone());
        }
        let end = (start + FILE_CHANGES_PAGE_SIZE).min(data.changes.len());
        let changes = if start < end {
            data.changes[start..end].to_vec()
        } else {
            Vec::new()
        };
        Ok(FileChangesPage {
            page,
            page_size: FILE_CHANGES_PAGE_SIZE,
            changes,
            scanned_count: data.changes.len(),
            available_count: data.changes.len(),
            complete: data.complete,
        })
    }

    pub fn export_changed_paths(
        &self,
        repository_path: &str,
        hash: &str,
        destination: &Path,
    ) -> Result<(), String> {
        let mut file =
            File::create(destination).map_err(|error| format!("无法创建导出文件：{error}"))?;
        self.run_git_stream(
            Some(repository_path),
            &[
                "diff-tree".into(),
                "--root".into(),
                "--no-commit-id".into(),
                "--name-status".into(),
                "-r".into(),
                "-M".into(),
                hash.into(),
            ],
            |chunk| {
                file.write_all(chunk)
                    .map_err(|error| format!("无法写入导出文件：{error}"))
            },
        )
    }

    pub fn write_comparison_files(
        &self,
        repository_path: &str,
        commit_hash: &str,
        parent_hash: Option<&str>,
        file_change: &FileChange,
        left: &Path,
        right: &Path,
    ) -> Result<(), String> {
        let left_path = file_change
            .previous_path
            .as_deref()
            .unwrap_or(&file_change.path);
        if file_change.status == "A" {
            File::create(left).map_err(|error| format!("无法创建临时对比文件：{error}"))?;
        } else {
            self.write_blob(repository_path, parent_hash, left_path, left)?;
        }
        if file_change.status == "D" {
            File::create(right).map_err(|error| format!("无法创建临时对比文件：{error}"))?;
        } else {
            self.write_blob(repository_path, Some(commit_hash), &file_change.path, right)?;
        }
        Ok(())
    }

    pub fn clone_remote_repository(
        &self,
        url: &str,
        destination: &Path,
    ) -> Result<RepositoryInfo, String> {
        if destination.exists() {
            return Err("目标目录已经存在。请选择一个不存在的目录。".into());
        }
        let parent = destination
            .parent()
            .ok_or_else(|| "目标目录无效。".to_string())?;
        fs::create_dir_all(parent).map_err(|error| format!("无法创建目标目录：{error}"))?;
        self.run_git(
            Some(parent.to_string_lossy().as_ref()),
            &[
                "clone".into(),
                "--filter=blob:none".into(),
                "--no-checkout".into(),
                url.into(),
                destination.to_string_lossy().into_owned(),
            ],
            64 * 1024 * 1024,
            || false,
            GIT_CLONE_TIMEOUT,
        )?;
        self.get_repository_info(destination.to_string_lossy().as_ref(), None, None)
    }

    fn write_blob(
        &self,
        repository_path: &str,
        revision: Option<&str>,
        file_path: &str,
        destination: &Path,
    ) -> Result<(), String> {
        let mut file =
            File::create(destination).map_err(|error| format!("无法创建临时对比文件：{error}"))?;
        let Some(revision) = revision else {
            return Ok(());
        };
        self.run_git_stream(
            Some(repository_path),
            &["show".into(), format!("{revision}:{file_path}")],
            |chunk| {
                file.write_all(chunk)
                    .map_err(|error| format!("无法写入临时对比文件：{error}"))
            },
        )
    }

    fn scan_file_changes(
        &self,
        repository_path: &str,
        path_scope: &str,
        hash: &str,
        cache: &FileChangesCache,
        generation: u64,
    ) -> Result<(), String> {
        let mut args = vec![
            "diff-tree".into(),
            "--root".into(),
            "--no-commit-id".into(),
            "--name-status".into(),
            "-r".into(),
            "-M".into(),
            format!("-l{MAX_RENAME_CANDIDATES}"),
            "-z".into(),
            hash.into(),
        ];
        if !path_scope.is_empty() {
            args.push("--".into());
            args.push(path_scope.into());
        }
        let mut pending = Vec::new();
        let mut status: Option<String> = None;
        let mut previous_path: Option<String> = None;
        let mut expected_paths = 0_u8;
        self.run_git_stream_with_timeout(
            Some(repository_path),
            &args,
            GIT_COMMAND_TIMEOUT,
            || self.file_changes_generation.load(Ordering::Acquire) != generation,
            |chunk| {
                pending.extend_from_slice(chunk);
                while let Some(index) = pending.iter().position(|byte| *byte == 0) {
                    let field = String::from_utf8_lossy(&pending[..index]).into_owned();
                    pending.drain(..=index);
                    if expected_paths == 0 {
                        if field.is_empty() {
                            continue;
                        }
                        let normalized = normalize_status(&field);
                        expected_paths = if normalized == "R" || normalized == "C" {
                            2
                        } else {
                            1
                        };
                        status = Some(normalized);
                        previous_path = None;
                    } else if expected_paths == 2 {
                        previous_path = Some(field);
                        expected_paths = 1;
                    } else {
                        let mut data = cache.data.lock().expect("file changes cache lock poisoned");
                        data.changes.push(FileChange {
                            status: status.take().unwrap_or_else(|| "X".into()),
                            path: field,
                            previous_path: previous_path.take(),
                        });
                        expected_paths = 0;
                        if data.changes.len() == INITIAL_FILE_CHANGES_AVAILABLE
                            || data.changes.len().is_multiple_of(FILE_CHANGES_PAGE_SIZE)
                        {
                            cache.progress.notify_all();
                        }
                    }
                }
                Ok(())
            },
        )
    }

    fn file_changes_cache(
        &self,
        repository_path: &str,
        path_scope: &str,
        hash: &str,
    ) -> Result<Arc<FileChangesCache>, String> {
        self.cached_file_changes(&file_changes_key(repository_path, path_scope, hash))
            .ok_or_else(|| "Git 读取已取消。".into())
    }

    fn cached_file_changes(&self, key: &str) -> Option<Arc<FileChangesCache>> {
        let access = self.file_changes_access.fetch_add(1, Ordering::Relaxed) + 1;
        let mut caches = self
            .file_changes
            .lock()
            .expect("file changes map lock poisoned");
        let entry = caches.get_mut(key)?;
        entry.last_access = access;
        Some(entry.cache.clone())
    }

    fn insert_file_changes_cache(&self, key: String, cache: Arc<FileChangesCache>) {
        let access = self.file_changes_access.fetch_add(1, Ordering::Relaxed) + 1;
        self.file_changes
            .lock()
            .expect("file changes map lock poisoned")
            .insert(
                key,
                FileChangesCacheEntry {
                    cache,
                    last_access: access,
                },
            );
        self.trim_file_changes_memory();
    }

    fn trim_file_changes_memory(&self) {
        let mut caches = self
            .file_changes
            .lock()
            .expect("file changes map lock poisoned");
        while caches.len() > MAX_MEMORY_FILE_CHANGES {
            let oldest = caches
                .iter()
                .filter(|(_, entry)| entry.cache.status().complete)
                .min_by_key(|(_, entry)| entry.last_access)
                .map(|(key, _)| key.clone());
            let Some(oldest) = oldest else {
                break;
            };
            caches.remove(&oldest);
        }
    }

    fn persisted_file_changes_path(
        &self,
        repository_path: &str,
        path_scope: &str,
        hash: &str,
    ) -> PathBuf {
        let digest = Sha256::digest(file_changes_key(repository_path, path_scope, hash));
        self.file_changes_cache_directory
            .join(format!("{digest:x}.paths.json"))
    }

    fn load_persisted_file_changes(
        &self,
        repository_path: &str,
        path_scope: &str,
        hash: &str,
    ) -> Option<Vec<FileChange>> {
        let path = self.persisted_file_changes_path(repository_path, path_scope, hash);
        let data = fs::read(&path).ok()?;
        let persisted: PersistedFileChanges = serde_json::from_slice(&data).ok()?;
        if persisted.version == FILE_CHANGES_CACHE_VERSION
            && persisted.repository_path == repository_path
            && persisted.path_scope == path_scope
            && persisted.hash == hash
        {
            Some(persisted.changes)
        } else {
            let _ = fs::remove_file(path);
            None
        }
    }

    fn persist_file_changes(
        &self,
        repository_path: &str,
        path_scope: &str,
        hash: &str,
        changes: &[FileChange],
    ) {
        let _ = fs::create_dir_all(&self.file_changes_cache_directory);
        let destination = self.persisted_file_changes_path(repository_path, path_scope, hash);
        let temporary = destination.with_extension("json.tmp");
        let persisted = PersistedFileChanges {
            version: FILE_CHANGES_CACHE_VERSION,
            repository_path: repository_path.to_string(),
            path_scope: path_scope.to_string(),
            hash: hash.to_string(),
            changes: changes.to_vec(),
        };
        if serde_json::to_vec(&persisted)
            .ok()
            .and_then(|data| fs::write(&temporary, data).ok())
            .is_some()
        {
            let _ = fs::remove_file(&destination);
            let _ = fs::rename(temporary, destination);
        }
        cleanup_persisted_file_changes(&self.file_changes_cache_directory);
    }

    fn try_git_text(&self, cwd: Option<&str>, args: &[String]) -> Option<String> {
        self.run_git(cwd, args, MAX_OUTPUT_BYTES, || false, GIT_COMMAND_TIMEOUT)
            .ok()
            .map(|value| String::from_utf8_lossy(&value).trim().to_string())
    }

    fn run_git(
        &self,
        cwd: Option<&str>,
        args: &[String],
        maximum_output: usize,
        cancelled: impl Fn() -> bool,
        timeout: Duration,
    ) -> Result<Vec<u8>, String> {
        let mut output = Vec::new();
        self.run_git_stream_with_timeout(cwd, args, timeout, cancelled, |chunk| {
            if output.len().saturating_add(chunk.len()) > maximum_output {
                return Err("Git 输出过大，已停止读取。请缩小筛选范围或改用外部对比工具。".into());
            }
            output.extend_from_slice(chunk);
            Ok(())
        })?;
        Ok(output)
    }

    fn run_git_stream(
        &self,
        cwd: Option<&str>,
        args: &[String],
        on_stdout: impl FnMut(&[u8]) -> Result<(), String>,
    ) -> Result<(), String> {
        self.run_git_stream_with_timeout(cwd, args, GIT_COMMAND_TIMEOUT, || false, on_stdout)
    }

    fn run_git_stream_with_timeout(
        &self,
        cwd: Option<&str>,
        args: &[String],
        timeout: Duration,
        cancelled: impl Fn() -> bool,
        on_stdout: impl FnMut(&[u8]) -> Result<(), String>,
    ) -> Result<(), String> {
        if let Some(location) = cwd
            .map(|path| self.parse_ssh_location(path))
            .transpose()?
            .flatten()
        {
            let command = remote_git_command(&location, args);
            let mut callback = on_stdout;
            self.ssh
                .execute(&location.mapping, None, &command, timeout, |chunk| {
                    if cancelled() {
                        Err("Git 读取已取消。".into())
                    } else {
                        callback(chunk)
                    }
                })?;
            return Ok(());
        }
        let mut child = Command::new("git")
            .args(args)
            .current_dir(cwd.unwrap_or("."))
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_PAGER", "cat")
            .env("LC_ALL", "C")
            .env("LANG", "C")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags_no_window()
            .spawn()
            .map_err(|error| format!("无法启动 git：{error}"))?;
        let stderr = child.stderr.take().expect("git stderr must be piped");
        let stderr_reader = thread::spawn(move || {
            let mut buffer = Vec::new();
            let _ = stderr.take(64 * 1024).read_to_end(&mut buffer);
            buffer
        });
        let mut stdout = child.stdout.take().expect("git stdout must be piped");
        let (stdout_sender, stdout_receiver) = mpsc::channel();
        let stdout_reader = thread::spawn(move || {
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                match stdout.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        if stdout_sender.send(Ok(buffer[..read].to_vec())).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = stdout_sender.send(Err(error));
                        break;
                    }
                }
            }
        });
        let mut callback = on_stdout;
        let deadline = Instant::now() + timeout;
        let stream_result = loop {
            if cancelled() {
                let _ = child.kill();
                break Err("Git 读取已取消。".into());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                let _ = child.kill();
                break Err(format!(
                    "git {} 执行超时。请缩小操作范围后重试。",
                    args.first().map_or("", String::as_str)
                ));
            }
            match stdout_receiver.recv_timeout(remaining.min(Duration::from_millis(200))) {
                Ok(Ok(chunk)) => {
                    if let Err(error) = callback(&chunk) {
                        let _ = child.kill();
                        break Err(error);
                    }
                }
                Ok(Err(error)) => {
                    let _ = child.kill();
                    break Err(format!("读取 git 输出失败：{error}"));
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break Ok(()),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        };
        let status = match child
            .wait_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|error| format!("等待 git 结束失败：{error}"))?
        {
            Some(status) => status,
            None => {
                let _ = child.kill();
                child
                    .wait()
                    .map_err(|error| format!("停止超时 git 任务失败：{error}"))?;
                return Err(format!(
                    "git {} 执行超时。请缩小操作范围后重试。",
                    args.first().map_or("", String::as_str)
                ));
            }
        };
        let stderr = stderr_reader.join().unwrap_or_default();
        let _ = stdout_reader.join();
        stream_result?;
        if status.success() {
            Ok(())
        } else {
            let detail = String::from_utf8_lossy(&stderr).trim().to_string();
            Err(if detail.is_empty() {
                format!("git {} 执行失败", args.first().map_or("", String::as_str))
            } else {
                detail
            })
        }
    }

    fn resolve_repository_path(&self, repository_path: &str) -> Result<String, String> {
        if repository_path.starts_with("ssh://") {
            return Ok(repository_path.to_string());
        }
        let Some(network) = windows_network_location(repository_path) else {
            return Ok(repository_path.to_string());
        };
        let candidates: Vec<_> = self
            .ssh
            .mappings()
            .into_iter()
            .filter(|mapping| same_network_host(&mapping.host, &network.host))
            .collect();
        match candidates.as_slice() {
            [] => Ok(repository_path.to_string()),
            [mapping] => create_ssh_home_path(&mapping.id, &network.relative_path),
            _ => Err(format!(
                "找到多个 {} 的 SSH 服务器配置。请保留一个配置。",
                network.host
            )),
        }
    }

    fn parse_ssh_location(&self, repository_path: &str) -> Result<Option<SshLocation>, String> {
        if !repository_path.starts_with("ssh://") {
            return Ok(None);
        }
        let url = Url::parse(repository_path)
            .map_err(|_| "SSH 仓库标识无效。请重新从映射盘打开仓库。".to_string())?;
        let mapping_id = percent_decode_str(url.host_str().unwrap_or_default())
            .decode_utf8_lossy()
            .to_lowercase();
        let mapping = self.ssh.mapping(&mapping_id)?;
        let mut segments: Vec<String> = url
            .path_segments()
            .into_iter()
            .flatten()
            .filter(|segment| !segment.is_empty())
            .map(|segment| percent_decode_str(segment).decode_utf8_lossy().into_owned())
            .collect();
        let uses_home_directory = segments
            .first()
            .is_some_and(|value| value == SSH_HOME_MARKER);
        if uses_home_directory {
            segments.remove(0);
        }
        let remote_path = if uses_home_directory {
            segments.join("/")
        } else {
            normalize_remote_path(&format!("/{}", segments.join("/")))?
        };
        Ok(Some(SshLocation {
            mapping,
            remote_path,
            uses_home_directory,
        }))
    }
}

#[cfg(windows)]
trait CommandWindowsExt {
    fn creation_flags_no_window(&mut self) -> &mut Self;
}

#[cfg(windows)]
impl CommandWindowsExt for Command {
    fn creation_flags_no_window(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.creation_flags(0x0800_0000)
    }
}

#[cfg(not(windows))]
trait CommandWindowsExt {
    fn creation_flags_no_window(&mut self) -> &mut Self;
}

#[cfg(not(windows))]
impl CommandWindowsExt for Command {
    fn creation_flags_no_window(&mut self) -> &mut Self {
        self
    }
}

fn parse_commit_records(output: &str) -> Vec<CommitSummary> {
    output
        .split(RECORD_SEPARATOR)
        .filter(|record| !record.is_empty())
        .filter_map(|record| {
            let values: Vec<_> = record.split(FIELD_SEPARATOR).collect();
            let hash = values.first()?.to_string();
            Some(CommitSummary {
                short_hash: hash.chars().take(8).collect(),
                hash,
                parents: values
                    .get(1)
                    .unwrap_or(&"")
                    .split_whitespace()
                    .map(str::to_string)
                    .collect(),
                author_name: values.get(2).unwrap_or(&"").to_string(),
                author_email: values.get(3).unwrap_or(&"").to_string(),
                date: values.get(4).unwrap_or(&"").to_string(),
                subject: values.get(5).unwrap_or(&"").to_string(),
                body: values
                    .get(6)
                    .unwrap_or(&"")
                    .trim_matches(['\r', '\n'])
                    .to_string(),
                refs: values
                    .get(7)
                    .unwrap_or(&"")
                    .split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .collect(),
            })
        })
        .collect()
}

fn parse_history_search_records(output: &str) -> Vec<HistorySearchRecord> {
    output
        .split(RECORD_SEPARATOR)
        .filter_map(|record| {
            let mut parts = record.split('\0');
            let metadata = parts.next()?.trim_start_matches(['\r', '\n']);
            if metadata.is_empty() {
                return None;
            }
            let values: Vec<_> = metadata.split(FIELD_SEPARATOR).collect();
            let hash = values.first()?.to_string();
            let subject = values.get(5).unwrap_or(&"").to_string();
            let message = values.get(7).unwrap_or(&"").trim().to_string();
            let commit = CommitSummary {
                short_hash: hash.chars().take(8).collect(),
                hash,
                parents: values
                    .get(1)
                    .unwrap_or(&"")
                    .split_whitespace()
                    .map(str::to_string)
                    .collect(),
                author_name: values.get(2).unwrap_or(&"").to_string(),
                author_email: values.get(3).unwrap_or(&"").to_string(),
                date: values.get(4).unwrap_or(&"").to_string(),
                body: message
                    .strip_prefix(&subject)
                    .unwrap_or(&message)
                    .trim_matches(['\r', '\n'])
                    .to_string(),
                subject,
                refs: values
                    .get(6)
                    .unwrap_or(&"")
                    .split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .collect(),
            };
            let paths = parts
                .map(|path| path.trim_matches(['\r', '\n']))
                .filter(|path| !path.is_empty())
                .map(str::to_string)
                .collect();
            Some(HistorySearchRecord {
                commit,
                message,
                paths,
            })
        })
        .collect()
}

fn history_record_matches(record: &HistorySearchRecord, scope: &str, needle: &str) -> bool {
    let message_matches = || record.message.to_lowercase().contains(needle);
    let author_matches = || {
        format!(
            "{}\n{}",
            record.commit.author_name, record.commit.author_email
        )
        .to_lowercase()
        .contains(needle)
    };
    let path_matches = || {
        record
            .paths
            .iter()
            .any(|path| path.to_lowercase().contains(needle))
    };
    let hash_matches = || record.commit.hash.to_lowercase().starts_with(needle);
    let refs_match = || {
        record
            .commit
            .refs
            .iter()
            .any(|reference| reference.to_lowercase().contains(needle))
    };

    match scope {
        "message" => message_matches(),
        "author" => author_matches(),
        "path" => path_matches(),
        "hash" => hash_matches(),
        _ => {
            message_matches()
                || author_matches()
                || path_matches()
                || hash_matches()
                || refs_match()
        }
    }
}

fn append_date_filter(args: &mut Vec<String>, filter: &HistoryFilter) {
    if !filter.from.is_empty() {
        args.push(format!("--since={}T00:00:00", filter.from));
    }
    if !filter.to.is_empty() {
        args.push(format!("--until={}T23:59:59", filter.to));
    }
}

fn cleanup_persisted_file_changes(directory: &Path) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let now = SystemTime::now();
    let mut files: Vec<_> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            if !path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".paths.json"))
            {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            Some((path, metadata.len(), modified))
        })
        .collect();

    files.retain(|(path, _, modified)| {
        let expired = now
            .duration_since(*modified)
            .is_ok_and(|age| age > MAX_PERSISTED_FILE_CHANGES_AGE);
        if expired {
            let _ = fs::remove_file(path);
        }
        !expired
    });
    files.sort_by_key(|(_, _, modified)| std::cmp::Reverse(*modified));
    let mut total_bytes = 0_u64;
    for (index, (path, length, _)) in files.into_iter().enumerate() {
        total_bytes = total_bytes.saturating_add(length);
        if index >= MAX_PERSISTED_FILE_CHANGES || total_bytes > MAX_PERSISTED_FILE_CHANGES_BYTES {
            let _ = fs::remove_file(path);
        }
    }
}

fn normalize_path_scope(value: &str) -> Result<String, String> {
    let value = value.trim().replace('\\', "/");
    if value.starts_with('/') {
        return Err("仓库子目录范围必须是相对路径。".into());
    }
    let mut segments = Vec::new();
    for segment in value
        .split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
    {
        if segment == ".." {
            return Err("仓库子目录范围无效。".into());
        }
        segments.push(segment);
    }
    Ok(segments.join("/"))
}

fn normalize_remote_path(value: &str) -> Result<String, String> {
    let mut segments = Vec::new();
    for segment in value.trim().split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            _ => segments.push(segment),
        }
    }
    if !value.trim().starts_with('/') || segments.is_empty() {
        return Err("服务器仓库路径必须是以 / 开头的绝对路径。".into());
    }
    Ok(format!("/{}", segments.join("/")))
}

fn normalize_status(value: &str) -> String {
    match value.chars().next().unwrap_or('X') {
        status @ ('A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U') => status.to_string(),
        _ => "X".into(),
    }
}

fn file_changes_key(repository_path: &str, path_scope: &str, hash: &str) -> String {
    format!("{repository_path}\0{path_scope}\0{hash}")
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn remote_git_command(location: &SshLocation, args: &[String]) -> String {
    let working_directory = if location.uses_home_directory {
        let suffix = location
            .remote_path
            .split('/')
            .filter(|segment| !segment.is_empty())
            .map(shell_quote)
            .collect::<Vec<_>>()
            .join("/");
        if suffix.is_empty() {
            "\"$HOME\"".into()
        } else {
            format!("\"$HOME\"/{suffix}")
        }
    } else {
        shell_quote(&location.remote_path)
    };
    format!(
        "GIT_OPTIONAL_LOCKS='0' GIT_PAGER='cat' LC_ALL='C' LANG='C' {}",
        std::iter::once(shell_quote("git"))
            .chain(std::iter::once(shell_quote("-C")))
            .chain(std::iter::once(working_directory))
            .chain(args.iter().map(|value| shell_quote(value)))
            .collect::<Vec<_>>()
            .join(" ")
    )
}

fn create_ssh_path(mapping_id: &str, remote_path: &str) -> Result<String, String> {
    let remote_path = normalize_remote_path(remote_path)?;
    Ok(format!(
        "ssh://{}{}",
        mapping_id.to_lowercase(),
        remote_path
            .split('/')
            .map(|segment| utf8_percent_encode(segment, NON_ALPHANUMERIC).to_string())
            .collect::<Vec<_>>()
            .join("/")
    ))
}

fn create_ssh_home_path(mapping_id: &str, relative_path: &str) -> Result<String, String> {
    let encoded = std::iter::once(SSH_HOME_MARKER)
        .chain(
            relative_path
                .split(['/', '\\'])
                .filter(|segment| !segment.is_empty()),
        )
        .map(|segment| utf8_percent_encode(segment, NON_ALPHANUMERIC).to_string())
        .collect::<Vec<_>>()
        .join("/");
    Ok(format!("ssh://{}/{}", mapping_id.to_lowercase(), encoded))
}

fn parse_network_path(value: &str) -> Option<NetworkLocation> {
    let normalized = value.trim().replace('/', "\\");
    let regex = Regex::new(r"^\\\\([^\\]+)\\([^\\]+)(?:\\(.*))?$").ok()?;
    let captures = regex.captures(&normalized)?;
    Some(NetworkLocation {
        host: captures.get(1)?.as_str().to_string(),
        relative_path: captures
            .get(3)
            .map_or("", |value| value.as_str())
            .trim_matches('\\')
            .to_string(),
    })
}

fn windows_network_location(path: &str) -> Option<NetworkLocation> {
    if let Some(location) = parse_network_path(path) {
        return Some(location);
    }
    let normalized = path.trim().replace('/', "\\");
    let drive = normalized.get(..2)?;
    if !drive.ends_with(':') || !drive.as_bytes().first()?.is_ascii_alphabetic() {
        return None;
    }
    let output = Command::new("net.exe")
        .args(["use", drive])
        .creation_flags_no_window()
        .output()
        .ok()
        .map(|output| [output.stdout, output.stderr].concat())
        .and_then(|output| String::from_utf8(output).ok())
        .or_else(|| {
            Command::new("reg.exe")
                .args([
                    "query",
                    &format!("HKCU\\Network\\{}", &drive[..1]),
                    "/v",
                    "RemotePath",
                ])
                .creation_flags_no_window()
                .output()
                .ok()
                .and_then(|output| String::from_utf8([output.stdout, output.stderr].concat()).ok())
        })?;
    let network_root = Regex::new(r"\\\\[^\\\s]+\\[^\\\s]+")
        .ok()?
        .find(&output)?
        .as_str();
    let mut location = parse_network_path(network_root)?;
    location.relative_path = normalized[2..].trim_matches('\\').to_string();
    Some(location)
}

fn same_network_host(left: &str, right: &str) -> bool {
    left.trim_matches(['[', ']'])
        .eq_ignore_ascii_case(right.trim_matches(['[', ']']))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_service(cache_directory: &Path) -> GitService {
        GitService::new(
            Arc::new(SshManager::new(Vec::new(), HashMap::new())),
            cache_directory.to_path_buf(),
        )
    }

    fn search_record() -> HistorySearchRecord {
        HistorySearchRecord {
            commit: CommitSummary {
                hash: "abcdef123456".into(),
                short_hash: "abcdef12".into(),
                parents: vec![],
                author_name: "Ryan".into(),
                author_email: "ryan@example.com".into(),
                date: "2026-08-13T10:00:00+08:00".into(),
                subject: "Improve search".into(),
                body: "Include file paths".into(),
                refs: vec!["HEAD -> main".into()],
            },
            message: "Improve search\n\nInclude file paths".into(),
            paths: vec!["src/renderer/App.tsx".into()],
        }
    }

    #[test]
    fn parses_unc_path() {
        let location = parse_network_path(r"\\server\share\team\repo").unwrap();
        assert_eq!(location.host, "server");
        assert_eq!(location.relative_path, r"team\repo");
    }

    #[test]
    fn quotes_shell_values() {
        assert_eq!(shell_quote("a'b"), "'a'\"'\"'b'");
    }

    #[test]
    fn creates_parseable_uuid_ssh_url() {
        let mapping_id = "9c00b70f-6ef9-4dc8-9a20-4ea709e96e9d";
        let value = create_ssh_path(mapping_id, "/srv/中文 repo").unwrap();
        let parsed = Url::parse(&value).unwrap();
        assert_eq!(parsed.host_str(), Some(mapping_id));
        assert_eq!(
            percent_decode_str(parsed.path()).decode_utf8_lossy(),
            "/srv/中文 repo"
        );
    }

    #[test]
    fn parses_multiline_commit_body() {
        let output = "\u{001e}abcdef123456\u{001f}\u{001f}Ryan\u{001f}ryan@example.com\u{001f}2026-08-13T10:00:00+08:00\u{001f}Improve search\u{001f}First detail\n\nSecond detail\n\u{001f}HEAD -> main";
        let commits = parse_commit_records(output);

        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].subject, "Improve search");
        assert_eq!(commits[0].body, "First detail\n\nSecond detail");
        assert_eq!(commits[0].refs, ["HEAD -> main"]);
    }

    #[test]
    fn all_history_search_includes_paths_and_refs() {
        let record = search_record();
        assert!(history_record_matches(&record, "all", "app.tsx"));
        assert!(history_record_matches(&record, "all", "main"));
    }

    #[test]
    fn history_search_respects_selected_scope() {
        let record = search_record();
        assert!(history_record_matches(&record, "author", "ryan"));
        assert!(!history_record_matches(&record, "message", "ryan"));
        assert!(history_record_matches(&record, "hash", "abcdef"));
        assert!(!history_record_matches(&record, "hash", "bcdef"));
    }

    #[test]
    fn parses_search_records_with_null_separated_paths() {
        let output = "\u{001e}abcdef123456\u{001f}\u{001f}Ryan\u{001f}ryan@example.com\u{001f}2026-08-13T10:00:00+08:00\u{001f}Improve search\u{001f}HEAD -> main\u{001f}Improve search\n\0\nsrc/App.tsx\0";
        let records = parse_history_search_records(output);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].commit.short_hash, "abcdef12");
        assert_eq!(records[0].paths, ["src/App.tsx"]);
    }

    #[test]
    fn searches_paths_beyond_the_first_result_page() {
        let repository = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let path = repository.path();
        let run = |args: &[&str]| {
            let status = Command::new("git")
                .args(args)
                .current_dir(path)
                .status()
                .unwrap();
            assert!(status.success());
        };
        run(&["init", "-q"]);
        run(&["config", "user.name", "Search Test"]);
        run(&["config", "user.email", "search@example.com"]);

        for index in 0..5 {
            let name = if index == 0 {
                "target-file.txt".to_string()
            } else {
                format!("other-{index}.txt")
            };
            fs::write(path.join(name), format!("commit {index}")).unwrap();
            run(&["add", "."]);
            run(&["commit", "-q", "-m", &format!("commit {index}")]);
        }

        let service = git_service(cache.path());
        let filter = HistoryFilter {
            query: "target-file".into(),
            scope: "all".into(),
            from: String::new(),
            to: String::new(),
            limit: 1,
        };
        let generation = service.next_history_request();
        let result = service
            .list_commits(
                path.to_string_lossy().as_ref(),
                None,
                None,
                &filter,
                0,
                generation,
            )
            .unwrap();

        assert_eq!(result.commits.len(), 1);
        assert_eq!(result.commits[0].subject, "commit 0");
        assert!(!result.has_more);
        assert_eq!(result.next_offset, 5);
    }
}
