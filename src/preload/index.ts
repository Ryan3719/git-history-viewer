import { contextBridge, ipcRenderer } from 'electron'
import type { ExternalDiffRequest, ExternalDiffSettings, HistoryFilter, RepositoryInfo } from '../shared/types'

contextBridge.exposeInMainWorld('gitHistory', {
  pickLocalRepository: () => ipcRenderer.invoke('repository:pick-local'),
  openRecentRepository: (repositoryPath: string) => ipcRenderer.invoke('repository:open-recent', repositoryPath),
  chooseCloneParent: () => ipcRenderer.invoke('repository:choose-clone-parent'),
  cloneRemoteRepository: (url: string, destination: string) => ipcRenderer.invoke('repository:clone', url, destination),
  listRecentRepositories: () => ipcRenderer.invoke('recent-repositories:list'),
  addRecentRepository: (repository: RepositoryInfo) => ipcRenderer.invoke('recent-repositories:add', repository),
  removeRecentRepository: (repositoryPath: string) => ipcRenderer.invoke('recent-repositories:remove', repositoryPath),
  clearRecentRepositories: () => ipcRenderer.invoke('recent-repositories:clear'),
  loadHistory: (repositoryPath: string, filter: HistoryFilter, offset = 0) => ipcRenderer.invoke('history:load', repositoryPath, filter, offset),
  cancelHistoryRequests: () => ipcRenderer.invoke('history:cancel'),
  getCommitDetails: (repositoryPath: string, hash: string) => ipcRenderer.invoke('history:details', repositoryPath, hash),
  getFileChangesPage: (repositoryPath: string, hash: string, page: number) => ipcRenderer.invoke('history:file-changes-page', repositoryPath, hash, page),
  exportChangedPaths: (repositoryPath: string, hash: string) => ipcRenderer.invoke('history:export-paths', repositoryPath, hash),
  getExternalDiffSettings: () => ipcRenderer.invoke('settings:external-diff:get'),
  chooseExternalDiffTool: () => ipcRenderer.invoke('settings:external-diff:choose'),
  saveExternalDiffSettings: (settings: ExternalDiffSettings) => ipcRenderer.invoke('settings:external-diff:save', settings),
  openExternalDiff: (request: ExternalDiffRequest) => ipcRenderer.invoke('external-diff:open', request),
  openGitForWindowsDownload: () => ipcRenderer.invoke('help:open-git-for-windows')
})
