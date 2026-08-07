export type SearchScope = 'all' | 'message' | 'author' | 'path' | 'hash'

export interface HistoryFilter {
  query: string
  scope: SearchScope
  from: string
  to: string
  limit: number
}

export interface RepositoryInfo {
  path: string
  displayPath?: string
  name: string
  branch: string
  head: string
}

export interface RecentRepository extends RepositoryInfo {
  lastOpenedAt: string
}

export interface CommitSummary {
  hash: string
  shortHash: string
  parents: string[]
  authorName: string
  authorEmail: string
  date: string
  subject: string
  refs: string[]
}

export interface HistoryPage {
  commits: CommitSummary[]
  hasMore: boolean
  nextOffset: number
}

export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | 'X'

export interface FileChange {
  status: ChangeStatus
  path: string
  previousPath?: string
}

export interface CommitDetails {
  hash: string
  parents: string[]
}

export interface FileChangesStatus {
  scannedCount: number
  availableCount: number
  complete: boolean
}

export interface FileChangesPage extends FileChangesStatus {
  page: number
  pageSize: number
  changes: FileChange[]
}

export interface ExternalDiffSettings {
  command: string
  argumentsTemplate: string
}

export type SshAuthenticationMethod = 'password' | 'privateKey' | 'agent'

export interface SshRepositoryMapping {
  id: string
  localPath: string
  host: string
  port: number
  username: string
  remotePath: string
  identityFile: string
  authMethod: SshAuthenticationMethod
}

export interface ExternalDiffRequest {
  repositoryPath: string
  commitHash: string
  parentHash?: string
  file: FileChange
  settings: ExternalDiffSettings
}

export interface GitHistoryApi {
  pickLocalRepository: () => Promise<RepositoryInfo | null>
  openRecentRepository: (repositoryPath: string) => Promise<RepositoryInfo>
  onRepositoryRequested: (callback: (repositoryPath: string) => void) => () => void
  notifyRepositoryListenerReady: () => Promise<void>
  listSshRepositoryMappings: () => Promise<SshRepositoryMapping[]>
  saveSshRepositoryMappings: (mappings: SshRepositoryMapping[]) => Promise<SshRepositoryMapping[]>
  setSshRepositoryPassword: (mappingId: string, password: string, remember: boolean) => Promise<void>
  testSshRepositoryMapping: (mapping: SshRepositoryMapping, password?: string) => Promise<void>
  chooseSshIdentityFile: () => Promise<string | null>
  chooseCloneParent: () => Promise<string | null>
  cloneRemoteRepository: (url: string, destination: string) => Promise<RepositoryInfo>
  listRecentRepositories: () => Promise<RecentRepository[]>
  addRecentRepository: (repository: RepositoryInfo) => Promise<RecentRepository[]>
  removeRecentRepository: (repositoryPath: string) => Promise<RecentRepository[]>
  clearRecentRepositories: () => Promise<void>
  loadHistory: (repositoryPath: string, filter: HistoryFilter, offset?: number) => Promise<HistoryPage>
  cancelHistoryRequests: () => Promise<void>
  getCommitDetails: (repositoryPath: string, hash: string) => Promise<CommitDetails>
  startFileChangesScan: (repositoryPath: string, hash: string) => Promise<FileChangesStatus>
  getFileChangesStatus: (repositoryPath: string, hash: string) => Promise<FileChangesStatus>
  getFileChangesPage: (repositoryPath: string, hash: string, page: number) => Promise<FileChangesPage>
  exportChangedPaths: (repositoryPath: string, hash: string) => Promise<boolean>
  getExternalDiffSettings: () => Promise<ExternalDiffSettings>
  chooseExternalDiffTool: () => Promise<string | null>
  saveExternalDiffSettings: (settings: ExternalDiffSettings) => Promise<void>
  openExternalDiff: (request: ExternalDiffRequest) => Promise<void>
  openGitForWindowsDownload: () => Promise<void>
  openUserDataDirectory: () => Promise<void>
}
