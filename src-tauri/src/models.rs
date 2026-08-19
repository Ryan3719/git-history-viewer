use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryFilter {
    pub query: String,
    pub scope: String,
    pub from: String,
    pub to: String,
    pub limit: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryInfo {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path_scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path_scope_kind: Option<String>,
    pub name: String,
    pub branch: String,
    pub head: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryOpenRequest {
    pub path: String,
    pub path_scope: Option<String>,
    pub path_scope_kind: Option<String>,
    #[serde(default)]
    pub is_file: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentRepository {
    #[serde(flatten)]
    pub repository: RepositoryInfo,
    pub last_opened_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSummary {
    pub hash: String,
    pub short_hash: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub date: String,
    pub subject: String,
    pub body: String,
    pub refs: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub commits: Vec<CommitSummary>,
    pub has_more: bool,
    pub next_offset: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub status: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_path: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct CommitDetails {
    pub hash: String,
    pub parents: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangesStatus {
    pub scanned_count: usize,
    pub available_count: usize,
    pub complete: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangesPage {
    pub page: usize,
    pub page_size: usize,
    pub changes: Vec<FileChange>,
    pub scanned_count: usize,
    pub available_count: usize,
    pub complete: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalDiffSettings {
    pub command: String,
    pub arguments_template: String,
}

impl Default for ExternalDiffSettings {
    fn default() -> Self {
        Self {
            command: String::new(),
            arguments_template: "\"{left}\" \"{right}\"".into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshRepositoryMapping {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub has_stored_password: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalDiffRequest {
    pub repository_path: String,
    pub commit_hash: String,
    pub parent_hash: Option<String>,
    pub file: FileChange,
    pub settings: ExternalDiffSettings,
}
