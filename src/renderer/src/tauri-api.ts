import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { open, save } from '@tauri-apps/plugin-dialog'
import { openUrl } from '@tauri-apps/plugin-opener'
import type {
  ExternalDiffRequest,
  ExternalDiffSettings,
  GitHistoryApi,
  HistoryFilter,
  RepositoryInfo,
  RepositoryOpenRequest,
  SshRepositoryMapping
} from '../../shared/types'

const gitForWindowsInstallUrl = 'https://git-scm.com/install/windows'

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await tauriInvoke<T>(command, args)
  } catch (error) {
    const message = typeof error === 'string' ? error : error instanceof Error ? error.message : String(error)
    const wrapped = new Error(message)
    if (message === 'Git 读取已取消。') wrapped.name = 'AbortError'
    throw wrapped
  }
}

function selectedPath(value: string | string[] | null): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value
}

export function createTauriGitHistoryApi(): GitHistoryApi {
  let repositoryListenerRegistration: Promise<void> = Promise.resolve()
  return {
    async pickLocalRepository() {
      const path = selectedPath(await open({ directory: true, multiple: false, title: '选择 Git 仓库' }))
      return path ? invoke<RepositoryInfo>('open_repository', { repository: { path } }) : null
    },
    openRecentRepository: (repository: RepositoryOpenRequest) => invoke('open_repository', { repository }),
    onRepositoryRequested(callback) {
      let disposed = false
      let unlisten: UnlistenFn | undefined
      repositoryListenerRegistration = listen<RepositoryOpenRequest>('repository-open-requested', (event) => callback(event.payload)).then((remove) => {
        if (disposed) remove()
        else unlisten = remove
      })
      return () => {
        disposed = true
        unlisten?.()
      }
    },
    async notifyRepositoryListenerReady() {
      await repositoryListenerRegistration.catch(() => undefined)
      await invoke('repository_listener_ready')
    },
    listSshRepositoryMappings: () => invoke('list_ssh_repository_mappings'),
    saveSshRepositoryMappings: (mappings: SshRepositoryMapping[]) => invoke('save_ssh_repository_mappings', { mappings }),
    setSshRepositoryPassword: (mappingId: string, password: string) => invoke('set_ssh_repository_password', { mappingId, password }),
    testSshRepositoryMapping: (mapping: SshRepositoryMapping, password?: string) => invoke('test_ssh_repository_mapping', { mapping, password }),
    async chooseCloneParent() {
      return selectedPath(await open({ directory: true, multiple: false, title: '选择仓库保存位置' }))
    },
    cloneRemoteRepository: (url: string, destination: string) => invoke('clone_remote_repository', { url, destination }),
    listRecentRepositories: () => invoke('list_recent_repositories'),
    addRecentRepository: (repository: RepositoryInfo) => invoke('add_recent_repository', { repository }),
    removeRecentRepository: (repository: RepositoryOpenRequest) => invoke('remove_recent_repository', { repository }),
    clearRecentRepositories: () => invoke('clear_recent_repositories'),
    loadHistory: (repositoryPath: string, pathScope: string | undefined, pathScopeKind: 'directory' | 'file' | undefined, filter: HistoryFilter, offset = 0) =>
      invoke('load_history', { repositoryPath, pathScope, pathScopeKind, filter, offset }),
    cancelHistoryRequests: () => invoke('cancel_history_requests'),
    getCommitDetails: (repositoryPath: string, hash: string) => invoke('get_commit_details', { repositoryPath, hash }),
    startFileChangesScan: (repositoryPath: string, pathScope: string | undefined, hash: string) =>
      invoke('start_file_changes_scan', { repositoryPath, pathScope, hash }),
    getFileChangesStatus: (repositoryPath: string, pathScope: string | undefined, hash: string) =>
      invoke('get_file_changes_status', { repositoryPath, pathScope, hash }),
    getFileChangesPage: (repositoryPath: string, pathScope: string | undefined, hash: string, page: number) =>
      invoke('get_file_changes_page', { repositoryPath, pathScope, hash, page }),
    async exportChangedPaths(repositoryPath: string, hash: string) {
      const destination = await save({
        title: '导出变更路径',
        defaultPath: `changed-paths-${hash.slice(0, 8)}.txt`,
        filters: [{ name: '文本文件', extensions: ['txt'] }]
      })
      if (!destination) return false
      await invoke('export_changed_paths', { repositoryPath, hash, destination })
      return true
    },
    getExternalDiffSettings: () => invoke('get_external_diff_settings'),
    async chooseExternalDiffTool() {
      return selectedPath(await open({
        directory: false,
        multiple: false,
        title: '选择外部对比工具',
        filters: [{ name: '应用程序', extensions: ['exe', 'cmd', 'bat'] }]
      }))
    },
    saveExternalDiffSettings: (settings: ExternalDiffSettings) => invoke('save_external_diff_settings', { settings }),
    openExternalDiff: (request: ExternalDiffRequest) => invoke('open_external_diff', { request }),
    openGitForWindowsDownload: () => openUrl(gitForWindowsInstallUrl),
    openUserDataDirectory: () => invoke('open_user_data_directory')
  }
}
