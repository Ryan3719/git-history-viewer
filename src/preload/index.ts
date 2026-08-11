import { contextBridge, ipcRenderer } from 'electron'
import type {
  ExternalDiffRequest,
  ExternalDiffSettings,
  HistoryFilter,
  RepositoryInfo,
  RepositoryOpenRequest,
  SshRepositoryMapping
} from '../shared/types'

contextBridge.exposeInMainWorld('gitHistory', {
  pickLocalRepository: () => ipcRenderer.invoke('repository:pick-local'),
  openRecentRepository: (repository: RepositoryOpenRequest) => ipcRenderer.invoke('repository:open-recent', repository),
  onRepositoryRequested: (callback: (repository: RepositoryOpenRequest) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, repository: RepositoryOpenRequest): void => callback(repository)
    ipcRenderer.on('repository:open-from-shell', listener)
    return () => ipcRenderer.removeListener('repository:open-from-shell', listener)
  },
  notifyRepositoryListenerReady: () => ipcRenderer.invoke('app:repository-listener-ready'),
  listSshRepositoryMappings: () => ipcRenderer.invoke('ssh-mappings:list'),
  saveSshRepositoryMappings: (mappings: SshRepositoryMapping[]) => ipcRenderer.invoke('ssh-mappings:save', mappings),
  setSshRepositoryPassword: (mappingId: string, password: string) => ipcRenderer.invoke('ssh-mappings:set-password', mappingId, password),
  testSshRepositoryMapping: (mapping: SshRepositoryMapping, password?: string) => ipcRenderer.invoke('ssh-mappings:test', mapping, password),
  chooseCloneParent: () => ipcRenderer.invoke('repository:choose-clone-parent'),
  cloneRemoteRepository: (url: string, destination: string) => ipcRenderer.invoke('repository:clone', url, destination),
  listRecentRepositories: () => ipcRenderer.invoke('recent-repositories:list'),
  addRecentRepository: (repository: RepositoryInfo) => ipcRenderer.invoke('recent-repositories:add', repository),
  removeRecentRepository: (repository: RepositoryOpenRequest) => ipcRenderer.invoke('recent-repositories:remove', repository),
  clearRecentRepositories: () => ipcRenderer.invoke('recent-repositories:clear'),
  loadHistory: (repositoryPath: string, pathScope: string | undefined, pathScopeKind: 'directory' | 'file' | undefined, filter: HistoryFilter, offset = 0) => ipcRenderer.invoke('history:load', repositoryPath, pathScope, pathScopeKind, filter, offset),
  cancelHistoryRequests: () => ipcRenderer.invoke('history:cancel'),
  getCommitDetails: (repositoryPath: string, hash: string) => ipcRenderer.invoke('history:details', repositoryPath, hash),
  startFileChangesScan: (repositoryPath: string, pathScope: string | undefined, hash: string) => ipcRenderer.invoke('history:file-changes:start', repositoryPath, pathScope, hash),
  getFileChangesStatus: (repositoryPath: string, pathScope: string | undefined, hash: string) => ipcRenderer.invoke('history:file-changes:status', repositoryPath, pathScope, hash),
  getFileChangesPage: (repositoryPath: string, pathScope: string | undefined, hash: string, page: number) => ipcRenderer.invoke('history:file-changes-page', repositoryPath, pathScope, hash, page),
  exportChangedPaths: (repositoryPath: string, hash: string) => ipcRenderer.invoke('history:export-paths', repositoryPath, hash),
  getExternalDiffSettings: () => ipcRenderer.invoke('settings:external-diff:get'),
  chooseExternalDiffTool: () => ipcRenderer.invoke('settings:external-diff:choose'),
  saveExternalDiffSettings: (settings: ExternalDiffSettings) => ipcRenderer.invoke('settings:external-diff:save', settings),
  openExternalDiff: (request: ExternalDiffRequest) => ipcRenderer.invoke('external-diff:open', request),
  openGitForWindowsDownload: () => ipcRenderer.invoke('help:open-git-for-windows'),
  openUserDataDirectory: () => ipcRenderer.invoke('app:open-user-data')
})
