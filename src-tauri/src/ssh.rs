use std::{
    collections::HashMap,
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use ssh2::Session;

use crate::models::SshRepositoryMapping;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(2 * 60);
const HANDSHAKE_ATTEMPTS: u32 = 3;
const HANDSHAKE_RETRY_DELAY: Duration = Duration::from_millis(250);

#[derive(Clone)]
struct Endpoint {
    mapping: SshRepositoryMapping,
    password: String,
}

struct SharedSession {
    endpoint: Endpoint,
    session: Mutex<Option<Session>>,
}

impl SharedSession {
    fn new(mapping: SshRepositoryMapping, password: String) -> Self {
        Self {
            endpoint: Endpoint { mapping, password },
            session: Mutex::new(None),
        }
    }

    fn matches(&self, mapping: &SshRepositoryMapping, password: &str) -> bool {
        self.endpoint.mapping.host == mapping.host
            && self.endpoint.mapping.port == mapping.port
            && self.endpoint.mapping.username == mapping.username
            && self.endpoint.password == password
    }

    fn execute(
        &self,
        command: &str,
        timeout: Duration,
        mut on_stdout: impl FnMut(&[u8]) -> Result<(), String>,
    ) -> Result<Vec<u8>, String> {
        let deadline = Instant::now() + timeout;
        let mut session_guard = self.session.lock().expect("SSH session lock poisoned");
        if session_guard.is_none() {
            *session_guard = Some(connect(&self.endpoint, deadline)?);
        }

        let execute = |session: &Session,
                       on_stdout: &mut dyn FnMut(&[u8]) -> Result<(), String>|
         -> Result<Vec<u8>, (String, bool)> {
            let apply_remaining_timeout = || -> Result<(), (String, bool)> {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err(("SSH 远程命令执行超时。请缩小操作范围后重试。".into(), false));
                }
                session.set_timeout(remaining.as_millis().clamp(1, u32::MAX.into()) as u32);
                Ok(())
            };
            apply_remaining_timeout()?;
            let mut emitted_output = false;
            let mut channel = session
                .channel_session()
                .map_err(|error| (format!("SSH 无法创建命令通道：{error}"), true))?;
            channel
                .exec(command)
                .map_err(|error| (format!("SSH 无法执行远程命令：{error}"), true))?;
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                apply_remaining_timeout()?;
                let read = channel.read(&mut buffer).map_err(|error| {
                    (
                        format!("SSH 读取远程命令输出失败：{error}"),
                        !emitted_output,
                    )
                })?;
                if read == 0 {
                    break;
                }
                on_stdout(&buffer[..read]).map_err(|error| (error, false))?;
                emitted_output = true;
            }
            let mut stderr = Vec::new();
            apply_remaining_timeout()?;
            channel
                .stderr()
                .take(64 * 1024)
                .read_to_end(&mut stderr)
                .map_err(|error| (format!("SSH 读取错误输出失败：{error}"), false))?;
            apply_remaining_timeout()?;
            channel.wait_close().map_err(|error| {
                (
                    format!("SSH 等待远程命令结束失败：{error}"),
                    !emitted_output,
                )
            })?;
            let code = channel.exit_status().unwrap_or(-1);
            if code == 0 {
                Ok(stderr)
            } else {
                let detail = String::from_utf8_lossy(&stderr).trim().to_string();
                Err((
                    if detail.is_empty() {
                        format!("SSH 远程命令执行失败，退出码 {code}。")
                    } else {
                        detail
                    },
                    false,
                ))
            }
        };

        let session = session_guard.as_ref().expect("SSH session must exist");
        match execute(session, &mut on_stdout) {
            Ok(stderr) => Ok(stderr),
            Err((error, false)) => Err(error),
            Err((_, true)) => {
                *session_guard = Some(connect(&self.endpoint, deadline)?);
                execute(
                    session_guard.as_ref().expect("SSH session must exist"),
                    &mut on_stdout,
                )
                .map_err(|(error, _)| error)
            }
        }
    }

    fn close(&self) {
        if let Some(session) = self
            .session
            .lock()
            .expect("SSH session lock poisoned")
            .take()
        {
            let _ = session.disconnect(None, "Application exiting", None);
        }
    }
}

fn connect(endpoint: &Endpoint, deadline: Instant) -> Result<Session, String> {
    let deadline = deadline.min(Instant::now() + CONNECT_TIMEOUT);
    let mapping = &endpoint.mapping;
    let address = (mapping.host.as_str(), mapping.port)
        .to_socket_addrs()
        .map_err(|error| format!("无法解析 SSH 服务器地址：{error}"))?
        .next()
        .ok_or_else(|| "无法解析 SSH 服务器地址。".to_string())?;
    let mut last_handshake_error = None;

    for attempt in 1..=HANDSHAKE_ATTEMPTS {
        let tcp = TcpStream::connect_timeout(&address, remaining_timeout(deadline)?).map_err(
            |error| match error.kind() {
                std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => {
                    "SSH 连接超时。请检查服务器地址和网络后重试。".into()
                }
                _ => format!("SSH 连接失败：{error}"),
            },
        )?;
        tcp.set_nodelay(true).ok();
        let mut session = Session::new().map_err(|error| format!("无法初始化 SSH：{error}"))?;
        session.set_timeout(timeout_millis(remaining_timeout(deadline)?));
        session.set_tcp_stream(tcp);

        match session.handshake() {
            Ok(()) => {
                session.set_timeout(timeout_millis(remaining_timeout(deadline)?));
                session
                    .userauth_password(&mapping.username, &endpoint.password)
                    .map_err(|error| format!("SSH 密码认证失败：{error}"))?;
                if !session.authenticated() {
                    return Err("SSH 密码认证失败。".into());
                }
                session.set_keepalive(true, 20);
                return Ok(session);
            }
            Err(error) => last_handshake_error = Some(error),
        }

        if attempt < HANDSHAKE_ATTEMPTS {
            std::thread::sleep(HANDSHAKE_RETRY_DELAY.min(remaining_timeout(deadline)?));
        }
    }

    Err(format!(
        "SSH 握手失败（已重试 {HANDSHAKE_ATTEMPTS} 次）：{}",
        last_handshake_error.expect("handshake attempts must capture an error")
    ))
}

fn remaining_timeout(deadline: Instant) -> Result<Duration, String> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        Err("SSH 操作超时。请检查网络后重试。".into())
    } else {
        Ok(remaining)
    }
}

fn timeout_millis(timeout: Duration) -> u32 {
    timeout.as_millis().clamp(1, u32::MAX.into()) as u32
}

fn is_timeout_error(error: &str) -> bool {
    let error = error.to_lowercase();
    error.contains("timeout") || error.contains("timed out") || error.contains("超时")
}

pub struct SshManager {
    mappings: Mutex<HashMap<String, SshRepositoryMapping>>,
    passwords: Mutex<HashMap<String, String>>,
    sessions: Mutex<HashMap<String, Arc<SharedSession>>>,
}

impl SshManager {
    pub fn new(mappings: Vec<SshRepositoryMapping>, passwords: HashMap<String, String>) -> Self {
        Self {
            mappings: Mutex::new(
                mappings
                    .into_iter()
                    .map(|mapping| (mapping.id.clone(), mapping))
                    .collect(),
            ),
            passwords: Mutex::new(passwords),
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn configure(&self, mappings: Vec<SshRepositoryMapping>) {
        let next: HashMap<_, _> = mappings
            .into_iter()
            .map(|mapping| (mapping.id.clone(), mapping))
            .collect();
        let mut sessions = self.sessions.lock().expect("SSH sessions lock poisoned");
        sessions.retain(|id, session| {
            let keep = next.get(id).is_some_and(|mapping| {
                let password = self
                    .passwords
                    .lock()
                    .expect("SSH passwords lock poisoned")
                    .get(id)
                    .cloned()
                    .unwrap_or_default();
                session.matches(mapping, &password)
            });
            if !keep {
                session.close();
            }
            keep
        });
        *self.mappings.lock().expect("SSH mappings lock poisoned") = next;
    }

    pub fn set_password(&self, mapping_id: &str, password: String) {
        let mapping_id = mapping_id.trim().to_lowercase();
        let changed = self
            .passwords
            .lock()
            .expect("SSH passwords lock poisoned")
            .insert(mapping_id.clone(), password.clone())
            .as_deref()
            != Some(password.as_str());
        if changed {
            if let Some(session) = self
                .sessions
                .lock()
                .expect("SSH sessions lock poisoned")
                .remove(&mapping_id)
            {
                session.close();
            }
        }
    }

    pub fn mapping(&self, mapping_id: &str) -> Result<SshRepositoryMapping, String> {
        self.mappings
            .lock()
            .expect("SSH mappings lock poisoned")
            .get(&mapping_id.to_lowercase())
            .cloned()
            .ok_or_else(|| "找不到此仓库对应的 SSH 服务器。请重新配置服务器。".into())
    }

    pub fn mappings(&self) -> Vec<SshRepositoryMapping> {
        self.mappings
            .lock()
            .expect("SSH mappings lock poisoned")
            .values()
            .cloned()
            .collect()
    }

    pub fn execute(
        &self,
        mapping: &SshRepositoryMapping,
        password: Option<&str>,
        command: &str,
        timeout: Duration,
        on_stdout: impl FnMut(&[u8]) -> Result<(), String>,
    ) -> Result<Vec<u8>, String> {
        let password = password
            .map(str::to_string)
            .or_else(|| {
                self.passwords
                    .lock()
                    .expect("SSH passwords lock poisoned")
                    .get(&mapping.id)
                    .cloned()
            })
            .ok_or_else(|| {
                format!(
                    "SSH 服务器“{}”需要密码。请编辑该服务器并输入密码后保存。",
                    mapping.host
                )
            })?;
        let session = {
            let mut sessions = self.sessions.lock().expect("SSH sessions lock poisoned");
            if let Some(existing) = sessions.get(&mapping.id) {
                if existing.matches(mapping, &password) {
                    existing.clone()
                } else {
                    existing.close();
                    let next = Arc::new(SharedSession::new(mapping.clone(), password.clone()));
                    sessions.insert(mapping.id.clone(), next.clone());
                    next
                }
            } else {
                let next = Arc::new(SharedSession::new(mapping.clone(), password.clone()));
                sessions.insert(mapping.id.clone(), next.clone());
                next
            }
        };
        let result = session.execute(command, timeout, on_stdout);
        if result
            .as_ref()
            .err()
            .is_some_and(|error| is_timeout_error(error))
        {
            let mut sessions = self.sessions.lock().expect("SSH sessions lock poisoned");
            if sessions
                .get(&mapping.id)
                .is_some_and(|current| Arc::ptr_eq(current, &session))
            {
                sessions.remove(&mapping.id);
            }
            drop(sessions);
            session.close();
        }
        result
    }

    pub fn test(
        &self,
        mapping: SshRepositoryMapping,
        password: Option<String>,
    ) -> Result<(), String> {
        let effective_password = password.or_else(|| {
            self.passwords
                .lock()
                .expect("SSH passwords lock poisoned")
                .get(&mapping.id)
                .cloned()
        });
        let configured = self
            .mappings
            .lock()
            .expect("SSH mappings lock poisoned")
            .get(&mapping.id)
            .is_some_and(|saved| {
                saved.host == mapping.host
                    && saved.port == mapping.port
                    && saved.username == mapping.username
            });
        let mut output = Vec::new();
        if configured {
            self.execute(
                &mapping,
                effective_password.as_deref(),
                "'git' '--version'",
                COMMAND_TIMEOUT,
                |chunk| output.write_all(chunk).map_err(|error| error.to_string()),
            )?;
        } else {
            let password = effective_password.ok_or_else(|| {
                format!(
                    "SSH 服务器“{}”需要密码。请编辑该服务器并输入密码后保存。",
                    mapping.host
                )
            })?;
            let temporary = SharedSession::new(mapping, password);
            let result = temporary.execute("'git' '--version'", COMMAND_TIMEOUT, |chunk| {
                output.write_all(chunk).map_err(|error| error.to_string())
            });
            temporary.close();
            result?;
        }
        if String::from_utf8_lossy(&output)
            .to_lowercase()
            .contains("git version")
        {
            Ok(())
        } else {
            Err("SSH 连接成功，但服务器无法执行 git --version。".into())
        }
    }

    pub fn close_all(&self) {
        for session in self
            .sessions
            .lock()
            .expect("SSH sessions lock poisoned")
            .drain()
            .map(|(_, session)| session)
        {
            session.close();
        }
    }
}
