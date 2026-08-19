use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::Write,
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    sync::Mutex,
};

use aes_gcm::{
    aead::{AeadInPlace, KeyInit},
    Aes256Gcm, Nonce, Tag,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    },
    Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH},
};

use crate::models::{
    ExternalDiffSettings, RecentRepository, RepositoryInfo, RepositoryOpenRequest,
    SshRepositoryMapping,
};

const MAXIMUM_RECENT_REPOSITORIES: usize = 5;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    arguments_template: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    recent_repositories: Vec<RecentRepository>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    ssh_repository_mappings: Vec<SshRepositoryMapping>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    ssh_repository_passwords: HashMap<String, String>,
}

pub struct SettingsStore {
    directory: PathBuf,
    settings: Mutex<StoredSettings>,
}

impl SettingsStore {
    pub fn load() -> Result<Self, String> {
        let directory = dirs::config_dir()
            .ok_or_else(|| "无法确定应用数据目录。".to_string())?
            .join("git-history-viewer");
        let path = directory.join("settings.json");
        let mut settings = fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str::<StoredSettings>(&text).ok())
            .unwrap_or_default();
        settings.recent_repositories = normalize_recent_repositories(settings.recent_repositories);
        settings.ssh_repository_mappings = normalize_mappings(settings.ssh_repository_mappings);
        settings.ssh_repository_passwords = settings
            .ssh_repository_passwords
            .into_iter()
            .filter_map(|(id, password)| {
                let id = id.trim().to_lowercase();
                (!id.is_empty() && !password.is_empty()).then_some((id, password))
            })
            .collect();
        Ok(Self {
            directory,
            settings: Mutex::new(settings),
        })
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    pub fn file_changes_directory(&self) -> PathBuf {
        self.directory.join("file-changes-cache")
    }

    pub fn external_diff(&self) -> ExternalDiffSettings {
        let settings = self.settings.lock().expect("settings lock poisoned");
        ExternalDiffSettings {
            command: settings.command.clone().unwrap_or_default(),
            arguments_template: settings
                .arguments_template
                .clone()
                .unwrap_or_else(|| "\"{left}\" \"{right}\"".into()),
        }
    }

    pub fn save_external_diff(&self, value: ExternalDiffSettings) -> Result<(), String> {
        self.update(|settings| {
            settings.command = Some(value.command);
            settings.arguments_template = Some(value.arguments_template);
        })
    }

    pub fn recent_repositories(&self) -> Vec<RecentRepository> {
        self.settings
            .lock()
            .expect("settings lock poisoned")
            .recent_repositories
            .clone()
    }

    pub fn add_recent_repository(
        &self,
        repository: RepositoryInfo,
    ) -> Result<Vec<RecentRepository>, String> {
        let key = repository_key(&repository.path, repository.path_scope.as_deref());
        let mut result = Vec::new();
        self.update(|settings| {
            let mut repositories = vec![RecentRepository {
                repository,
                last_opened_at: Utc::now().to_rfc3339(),
            }];
            repositories.extend(
                settings
                    .recent_repositories
                    .iter()
                    .filter(|item| {
                        repository_key(&item.repository.path, item.repository.path_scope.as_deref())
                            != key
                    })
                    .cloned(),
            );
            settings.recent_repositories = normalize_recent_repositories(repositories);
            result.clone_from(&settings.recent_repositories);
        })?;
        Ok(result)
    }

    pub fn remove_recent_repository(
        &self,
        repository: &RepositoryOpenRequest,
    ) -> Result<Vec<RecentRepository>, String> {
        let key = repository_key(&repository.path, repository.path_scope.as_deref());
        let mut result = Vec::new();
        self.update(|settings| {
            settings.recent_repositories.retain(|item| {
                repository_key(&item.repository.path, item.repository.path_scope.as_deref()) != key
            });
            result.clone_from(&settings.recent_repositories);
        })?;
        Ok(result)
    }

    pub fn clear_recent_repositories(&self) -> Result<(), String> {
        self.update(|settings| settings.recent_repositories.clear())
    }

    pub fn mappings(&self) -> Vec<SshRepositoryMapping> {
        let settings = self.settings.lock().expect("settings lock poisoned");
        settings
            .ssh_repository_mappings
            .iter()
            .cloned()
            .map(|mut mapping| {
                mapping.has_stored_password =
                    settings.ssh_repository_passwords.contains_key(&mapping.id);
                mapping
            })
            .collect()
    }

    pub fn save_mappings(
        &self,
        mappings: Vec<SshRepositoryMapping>,
    ) -> Result<Vec<SshRepositoryMapping>, String> {
        let mappings = normalize_mappings(mappings);
        let ids: HashSet<_> = mappings.iter().map(|item| item.id.clone()).collect();
        self.update(|settings| {
            settings
                .ssh_repository_passwords
                .retain(|id, _| ids.contains(id));
            settings.ssh_repository_mappings.clone_from(&mappings);
        })?;
        Ok(self.mappings())
    }

    pub fn set_password(&self, mapping_id: &str, password: &str) -> Result<(), String> {
        let mapping_id = mapping_id.trim().to_lowercase();
        if password.is_empty() {
            return Err("SSH 密码不能为空。".into());
        }
        let encrypted = protect_password(password)?;
        self.update(|settings| {
            settings
                .ssh_repository_passwords
                .insert(mapping_id, encrypted);
        })
    }

    pub fn decrypted_passwords(&self) -> HashMap<String, String> {
        self.settings
            .lock()
            .expect("settings lock poisoned")
            .ssh_repository_passwords
            .iter()
            .filter_map(|(id, encrypted)| {
                unprotect_password(encrypted, &self.directory)
                    .ok()
                    .map(|password| (id.clone(), password))
            })
            .collect()
    }

    fn update(&self, operation: impl FnOnce(&mut StoredSettings)) -> Result<(), String> {
        let mut settings = self.settings.lock().expect("settings lock poisoned");
        let mut next = settings.clone();
        operation(&mut next);
        fs::create_dir_all(&self.directory)
            .map_err(|error| format!("无法创建应用数据目录：{error}"))?;
        let temporary = self.directory.join("settings.json.tmp");
        let destination = self.directory.join("settings.json");
        let data = serde_json::to_vec_pretty(&next)
            .map_err(|error| format!("无法序列化应用设置：{error}"))?;
        let mut file =
            File::create(&temporary).map_err(|error| format!("无法写入应用设置：{error}"))?;
        file.write_all(&data)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("无法写入应用设置：{error}"))?;
        drop(file);
        replace_file(&temporary, &destination)?;
        settings.clone_from(&next);
        Ok(())
    }
}

fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let success = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if success == 0 {
        return Err(format!(
            "无法更新应用设置：{}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

fn normalize_mappings(value: Vec<SshRepositoryMapping>) -> Vec<SshRepositoryMapping> {
    let mut mappings = HashMap::new();
    for mut mapping in value {
        mapping.id = mapping.id.trim().to_lowercase();
        mapping.host = mapping.host.trim().to_string();
        mapping.username = mapping.username.trim().to_string();
        mapping.has_stored_password = false;
        if mapping.id.is_empty() || mapping.host.is_empty() || mapping.username.is_empty() {
            continue;
        }
        mappings.insert(mapping.id.clone(), mapping);
    }
    let mut result: Vec<_> = mappings.into_values().collect();
    result.sort_by(|left, right| left.id.cmp(&right.id));
    result
}

fn normalize_recent_repositories(value: Vec<RecentRepository>) -> Vec<RecentRepository> {
    let mut by_path = HashMap::new();
    for mut recent in value {
        recent.repository.path_scope =
            normalize_path_scope(recent.repository.path_scope.as_deref());
        if recent.repository.path_scope.is_none() {
            recent.repository.path_scope_kind = None;
        } else if recent.repository.path_scope_kind.as_deref() != Some("file") {
            recent.repository.path_scope_kind = Some("directory".into());
        }
        by_path.insert(
            repository_key(
                &recent.repository.path,
                recent.repository.path_scope.as_deref(),
            ),
            recent,
        );
    }
    let mut result: Vec<_> = by_path.into_values().collect();
    result.sort_by(|left, right| right.last_opened_at.cmp(&left.last_opened_at));
    result.truncate(MAXIMUM_RECENT_REPOSITORIES);
    result
}

fn normalize_path_scope(value: Option<&str>) -> Option<String> {
    let segments: Vec<_> = value?
        .trim()
        .replace('\\', "/")
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(str::to_string)
        .collect();
    if segments.is_empty()
        || segments
            .iter()
            .any(|segment| segment == "." || segment == "..")
    {
        None
    } else {
        Some(segments.join("/"))
    }
}

fn repository_key(path: &str, path_scope: Option<&str>) -> String {
    format!(
        "{}\0{}",
        path.trim_end_matches(['/', '\\']).to_lowercase(),
        path_scope
            .unwrap_or_default()
            .trim_start_matches("./")
            .trim_end_matches('/')
            .replace('\\', "/")
            .to_lowercase()
    )
}

fn protect_password(password: &str) -> Result<String, String> {
    let bytes = password.as_bytes();
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let success = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if success == 0 {
        return Err("Windows 凭据加密当前不可用，无法安全保存 SSH 密码。".into());
    }
    let encrypted = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
    let encoded = BASE64.encode(encrypted);
    unsafe {
        LocalFree(output.pbData.cast());
    }
    Ok(encoded)
}

fn unprotect_password(value: &str, user_data_directory: &Path) -> Result<String, String> {
    let encrypted = BASE64
        .decode(value)
        .map_err(|_| "已保存的 SSH 密码格式无效。".to_string())?;
    if encrypted.starts_with(b"v10") || encrypted.starts_with(b"v11") {
        return unprotect_electron_password(&encrypted, user_data_directory);
    }
    unprotect_dpapi_bytes(&encrypted)
}

fn unprotect_electron_password(
    encrypted: &[u8],
    user_data_directory: &Path,
) -> Result<String, String> {
    let local_state = fs::read(user_data_directory.join("Local State"))
        .map_err(|_| "找不到旧版 SSH 密码的加密密钥。请重新输入密码。".to_string())?;
    let value: serde_json::Value = serde_json::from_slice(&local_state)
        .map_err(|_| "旧版 SSH 密码的加密密钥无效。请重新输入密码。".to_string())?;
    let encrypted_key = value
        .pointer("/os_crypt/encrypted_key")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "找不到旧版 SSH 密码的加密密钥。请重新输入密码。".to_string())?;
    let protected_key = BASE64
        .decode(encrypted_key)
        .map_err(|_| "旧版 SSH 密码的加密密钥无效。请重新输入密码。".to_string())?;
    let protected_key = protected_key
        .strip_prefix(b"DPAPI")
        .ok_or_else(|| "旧版 SSH 密码的加密密钥格式不受支持。请重新输入密码。".to_string())?;
    let key = unprotect_dpapi_data(protected_key)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| "旧版 SSH 密码的加密密钥长度无效。请重新输入密码。".to_string())?;
    let payload = encrypted
        .get(3..)
        .ok_or_else(|| "旧版 SSH 密码数据无效。请重新输入密码。".to_string())?;
    let nonce_bytes = payload
        .get(..12)
        .ok_or_else(|| "旧版 SSH 密码数据无效。请重新输入密码。".to_string())?;
    let encrypted_and_tag = payload
        .get(12..)
        .ok_or_else(|| "旧版 SSH 密码数据无效。请重新输入密码。".to_string())?;
    if encrypted_and_tag.len() < 16 {
        return Err("旧版 SSH 密码数据无效。请重新输入密码。".into());
    }
    let (ciphertext, tag_bytes) = encrypted_and_tag.split_at(encrypted_and_tag.len() - 16);
    let mut plaintext = ciphertext.to_vec();
    cipher
        .decrypt_in_place_detached(
            Nonce::from_slice(nonce_bytes),
            b"",
            &mut plaintext,
            Tag::from_slice(tag_bytes),
        )
        .map_err(|_| "无法解密旧版 SSH 密码。请重新输入密码。".to_string())?;
    String::from_utf8(plaintext).map_err(|_| "旧版 SSH 密码内容无效。请重新输入密码。".to_string())
}

fn unprotect_dpapi_bytes(encrypted: &[u8]) -> Result<String, String> {
    let decrypted = unprotect_dpapi_data(encrypted)?;
    String::from_utf8(decrypted).map_err(|_| "已保存的 SSH 密码内容无效。".to_string())
}

fn unprotect_dpapi_data(encrypted: &[u8]) -> Result<Vec<u8>, String> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: encrypted.len() as u32,
        pbData: encrypted.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let success = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if success == 0 {
        return Err("无法使用当前 Windows 帐户解密 SSH 密码。".into());
    }
    let decrypted = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
    let value = decrypted.to_vec();
    unsafe {
        LocalFree(output.pbData.cast());
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decrypts_existing_electron_password_when_present() {
        let Some(directory) = dirs::config_dir().map(|path| path.join("git-history-viewer")) else {
            return;
        };
        let Ok(raw) = fs::read(directory.join("settings.json")) else {
            return;
        };
        let Ok(settings) = serde_json::from_slice::<StoredSettings>(&raw) else {
            return;
        };
        let Some(encrypted) = settings.ssh_repository_passwords.values().next() else {
            return;
        };
        let password = unprotect_password(encrypted, &directory)
            .expect("existing Electron password should decrypt for the same Windows account");
        assert!(!password.is_empty());
    }

    #[test]
    fn dpapi_round_trip() {
        let encrypted = protect_password("test-password-123").unwrap();
        let decrypted = unprotect_password(&encrypted, Path::new(".")).unwrap();
        assert_eq!(decrypted, "test-password-123");
    }

    #[test]
    fn failed_write_does_not_change_in_memory_settings() {
        let temporary = tempfile::tempdir().unwrap();
        let blocker = temporary.path().join("not-a-directory");
        fs::write(&blocker, b"block").unwrap();
        let store = SettingsStore {
            directory: blocker.join("settings"),
            settings: Mutex::new(StoredSettings::default()),
        };

        let result = store.save_external_diff(ExternalDiffSettings {
            command: "diff.exe".into(),
            arguments_template: "{left} {right}".into(),
        });

        assert!(result.is_err());
        assert_eq!(store.external_diff().command, "");
    }
}
