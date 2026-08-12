import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell } from 'electron'
import { basename, dirname, extname, join } from 'node:path'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import {
  cloneRemoteRepository,
  closeSshRepositoryConnections,
  configureFileChangesCacheDirectory,
  configureSshRepositoryMappings,
  exportChangedPaths as exportGitChangedPaths,
  getCommitDetails,
  getFileChangesPage,
  getFileChangesStatus,
  getRepositoryInfo,
  listCommits,
  setSshRepositoryPassword,
  startFileChangesScan,
  testSshRepositoryMapping,
  writeComparisonFiles
} from './git'
import type {
  ExternalDiffRequest,
  ExternalDiffSettings,
  HistoryFilter,
  RecentRepository,
  RepositoryInfo,
  RepositoryOpenRequest,
  SshRepositoryMapping
} from '../shared/types'

let mainWindow: BrowserWindow | undefined
let rendererRepositoryListenerReady = false
let pendingRepositoryPath = parseRepositoryPath(process.argv)
const historyLoadRequests = new Map<number, AbortController>()
const historyDetailRequests = new Map<number, AbortController>()
const fileChangesRequests = new Map<number, AbortController>()
const defaultExternalDiffSettings: ExternalDiffSettings = {
  command: '',
  argumentsTemplate: '"{left}" "{right}"'
}
const maximumRecentRepositories = 5
const gitForWindowsInstallUrl = 'https://git-scm.com/install/windows'

interface StoredSettings {
  command?: string
  argumentsTemplate?: string
  recentRepositories?: RecentRepository[]
  sshRepositoryMappings?: SshRepositoryMapping[]
  sshRepositoryPasswords?: Record<string, string>
}

let settingsWriteQueue = Promise.resolve()
let storedSettingsCache: StoredSettings | undefined
let settingsLoadPromise: Promise<StoredSettings> | undefined

function parseRepositoryPath(argv: string[]): RepositoryOpenRequest | null {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--repo' || argument === '--file') {
      const repositoryPath = argv[index + 1]?.trim()
      return repositoryPath ? { path: repositoryPath, ...(argument === '--file' ? { isFile: true } : {}) } : null
    }
    if (argument.startsWith('--repo=')) {
      const repositoryPath = argument.slice('--repo='.length).trim()
      return repositoryPath ? { path: repositoryPath } : null
    }
    if (argument.startsWith('--file=')) {
      const repositoryPath = argument.slice('--file='.length).trim()
      return repositoryPath ? { path: repositoryPath, isFile: true } : null
    }
  }
  return null
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function sendPendingRepositoryRequest(): void {
  if (!pendingRepositoryPath || !rendererRepositoryListenerReady || !mainWindow || mainWindow.isDestroyed()) return
  const repository = pendingRepositoryPath
  pendingRepositoryPath = null
  mainWindow.webContents.send('repository:open-from-shell', repository)
}

function requestRepositoryOpen(repository: RepositoryOpenRequest | null): void {
  if (!repository) return
  pendingRepositoryPath = repository
  focusMainWindow()
  sendPendingRepositoryRequest()
}

async function runLatestRequest<T>(
  requests: Map<number, AbortController>,
  senderId: number,
  task: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  requests.get(senderId)?.abort()
  const controller = new AbortController()
  requests.set(senderId, controller)
  try {
    return await task(controller.signal)
  } finally {
    if (requests.get(senderId) === controller) requests.delete(senderId)
  }
}

function abortRequestsForWebContents(senderId: number): void {
  historyLoadRequests.get(senderId)?.abort()
  historyDetailRequests.get(senderId)?.abort()
  fileChangesRequests.get(senderId)?.abort()
  historyLoadRequests.delete(senderId)
  historyDetailRequests.delete(senderId)
  fileChangesRequests.delete(senderId)
}

function windowIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.ico')
    : join(app.getAppPath(), 'resources', 'icon.ico')
}

function createWindow(): void {
  rendererRepositoryListenerReady = false
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1100,
    minHeight: 720,
    show: true,
    title: 'Git History Viewer',
    icon: windowIconPath(),
    backgroundColor: '#eef1f4',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  const webContentsId = mainWindow.webContents.id
  mainWindow.webContents.on('did-start-loading', () => {
    rendererRepositoryListenerReady = false
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.once('destroyed', () => {
    rendererRepositoryListenerReady = false
    abortRequestsForWebContents(webContentsId)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function repositoryPathKey(repository: Pick<RepositoryInfo, 'path' | 'pathScope'>): string {
  const root = repository.path.replace(/[\\/]+$/, '').toLocaleLowerCase()
  const pathScope = (repository.pathScope ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLocaleLowerCase()
  return `${root}\u0000${pathScope}`
}

function normalizeRecentPathScope(value: unknown): string {
  if (typeof value !== 'string') return ''
  const segments = value.trim().replace(/\\/g, '/').split('/').filter(Boolean)
  if (segments.some((segment) => segment === '.' || segment === '..')) return ''
  return segments.join('/')
}

function normalizeRecentRepositories(value: unknown): RecentRepository[] {
  if (!Array.isArray(value)) return []
  const byPath = new Map<string, RecentRepository>()
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const repository = item as Partial<RecentRepository>
    if (
      typeof repository.path !== 'string' ||
      typeof repository.name !== 'string' ||
      typeof repository.branch !== 'string' ||
      typeof repository.head !== 'string' ||
      typeof repository.lastOpenedAt !== 'string'
    ) {
      continue
    }
    const pathScope = normalizeRecentPathScope(repository.pathScope)
    const pathScopeKind = repository.pathScopeKind === 'file' ? 'file' : 'directory'
    const { pathScope: _storedPathScope, pathScopeKind: _storedPathScopeKind, ...repositoryWithoutPathScope } = repository as RecentRepository
    const normalizedRepository: RecentRepository = {
      ...repositoryWithoutPathScope,
      ...(pathScope ? { pathScope, pathScopeKind } : {})
    }
    byPath.set(repositoryPathKey(normalizedRepository), normalizedRepository)
  }
  return [...byPath.values()]
    .sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt))
    .slice(0, maximumRecentRepositories)
}

function normalizeSshRepositoryMappings(value: unknown): SshRepositoryMapping[] {
  if (!Array.isArray(value)) return []
  const mappings = new Map<string, SshRepositoryMapping>()
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const mapping = item as Partial<SshRepositoryMapping>
    const host = typeof mapping.host === 'string' ? mapping.host.trim() : ''
    const username = typeof mapping.username === 'string' ? mapping.username.trim() : ''
    const port = Math.floor(Number(mapping.port))
    if (
      !host ||
      !username ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      continue
    }
    const id = typeof mapping.id === 'string' && mapping.id.trim() ? mapping.id.trim().toLocaleLowerCase() : randomUUID()
    mappings.set(id, {
      id,
      host,
      port,
      username
    })
  }
  return [...mappings.values()]
}

function normalizeStoredSshPasswords(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const passwords: Record<string, string> = {}
  for (const [mappingId, encryptedPassword] of Object.entries(value)) {
    const normalizedMappingId = mappingId.trim().toLocaleLowerCase()
    if (normalizedMappingId && typeof encryptedPassword === 'string' && encryptedPassword) {
      passwords[normalizedMappingId] = encryptedPassword
    }
  }
  return passwords
}

async function loadStoredSettings(): Promise<StoredSettings> {
  if (storedSettingsCache) return storedSettingsCache
  if (settingsLoadPromise) return settingsLoadPromise

  const loading = (async () => {
    try {
      const data = JSON.parse(await readFile(settingsPath(), 'utf8')) as StoredSettings
      return {
        command: typeof data.command === 'string' ? data.command : undefined,
        argumentsTemplate: typeof data.argumentsTemplate === 'string' ? data.argumentsTemplate : undefined,
        recentRepositories: normalizeRecentRepositories(data.recentRepositories),
        sshRepositoryMappings: normalizeSshRepositoryMappings(data.sshRepositoryMappings),
        sshRepositoryPasswords: normalizeStoredSshPasswords(data.sshRepositoryPasswords)
      }
    } catch {
      return {}
    }
  })()
  settingsLoadPromise = loading
  try {
    storedSettingsCache = await loading
    return storedSettingsCache
  } finally {
    if (settingsLoadPromise === loading) settingsLoadPromise = undefined
  }
}

async function updateStoredSettings<T>(
  update: (settings: StoredSettings) => { settings: StoredSettings; result: T }
): Promise<T> {
  const operation = settingsWriteQueue.then(async () => {
    const current = await loadStoredSettings()
    const next = update(current)
    await mkdir(app.getPath('userData'), { recursive: true })
    await writeFile(settingsPath(), JSON.stringify(next.settings, null, 2), 'utf8')
    storedSettingsCache = next.settings
    return next.result
  })
  settingsWriteQueue = operation.then(() => undefined, () => undefined)
  return operation
}

async function loadExternalDiffSettings(): Promise<ExternalDiffSettings> {
  const data = await loadStoredSettings()
  return {
    command: data.command ?? '',
    argumentsTemplate: data.argumentsTemplate ?? defaultExternalDiffSettings.argumentsTemplate
  }
}

async function saveExternalDiffSettings(settings: ExternalDiffSettings): Promise<void> {
  await updateStoredSettings((current) => ({
    settings: { ...current, command: settings.command, argumentsTemplate: settings.argumentsTemplate },
    result: undefined
  }))
}

async function listSshRepositoryMappings(): Promise<SshRepositoryMapping[]> {
  const settings = await loadStoredSettings()
  const passwords = normalizeStoredSshPasswords(settings.sshRepositoryPasswords)
  return (settings.sshRepositoryMappings ?? []).map((mapping) => ({
    ...mapping,
    hasStoredPassword: Boolean(passwords[mapping.id])
  }))
}

async function saveSshRepositoryMappings(mappings: SshRepositoryMapping[]): Promise<SshRepositoryMapping[]> {
  const normalizedMappings = normalizeSshRepositoryMappings(mappings)
  const mappingIds = new Set(normalizedMappings.map((mapping) => mapping.id))
  const saved = await updateStoredSettings((current) => {
    const passwords = Object.fromEntries(Object.entries(normalizeStoredSshPasswords(current.sshRepositoryPasswords))
      .filter(([mappingId]) => mappingIds.has(mappingId)))
    return {
      settings: {
        ...current,
        sshRepositoryMappings: normalizedMappings,
        sshRepositoryPasswords: passwords
      },
      result: { mappings: normalizedMappings, passwords }
    }
  })
  configureSshRepositoryMappings(saved.mappings)
  return saved.mappings.map((mapping) => ({
    ...mapping,
    hasStoredPassword: Boolean(saved.passwords[mapping.id])
  }))
}

async function openRepository(repository: RepositoryOpenRequest | string): Promise<RepositoryInfo> {
  const request: RepositoryOpenRequest = typeof repository === 'string' ? { path: repository } : repository
  if (request.isFile) {
    const parentRepository = await getRepositoryInfo(dirname(request.path))
    const pathScope = [parentRepository.pathScope, basename(request.path)].filter(Boolean).join('/')
    return { ...parentRepository, pathScope, pathScopeKind: 'file' }
  }
  return getRepositoryInfo(request.path, request.pathScope, request.pathScopeKind)
}

async function setStoredSshRepositoryPassword(mappingId: string, password: string): Promise<void> {
  const normalizedMappingId = mappingId.trim().toLocaleLowerCase()
  if (!password) throw new Error('SSH 密码不能为空。')
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows 凭据加密当前不可用，无法安全保存 SSH 密码。')
  }
  const encryptedPassword = safeStorage.encryptString(password).toString('base64')
  await updateStoredSettings((current) => {
    const passwords = normalizeStoredSshPasswords(current.sshRepositoryPasswords)
    passwords[normalizedMappingId] = encryptedPassword
    return {
      settings: { ...current, sshRepositoryPasswords: passwords },
      result: undefined
    }
  })
  setSshRepositoryPassword(normalizedMappingId, password)
}

function restoreStoredSshPasswords(settings: StoredSettings): void {
  for (const [mappingId, encryptedPassword] of Object.entries(settings.sshRepositoryPasswords ?? {})) {
    try {
      if (!safeStorage.isEncryptionAvailable()) continue
      setSshRepositoryPassword(mappingId, safeStorage.decryptString(Buffer.from(encryptedPassword, 'base64')))
    } catch {
      // Ignore malformed or unavailable credentials. The user can enter a new password in SSH mappings.
    }
  }
}

async function listRecentRepositories(): Promise<RecentRepository[]> {
  return (await loadStoredSettings()).recentRepositories ?? []
}

async function addRecentRepository(repository: RepositoryInfo): Promise<RecentRepository[]> {
  return updateStoredSettings((current) => {
    const record: RecentRepository = { ...repository, lastOpenedAt: new Date().toISOString() }
    const recentRepositories = normalizeRecentRepositories([
      record,
      ...(current.recentRepositories ?? []).filter((item) => repositoryPathKey(item) !== repositoryPathKey(repository))
    ])
    return { settings: { ...current, recentRepositories }, result: recentRepositories }
  })
}

async function removeRecentRepository(repository: RepositoryOpenRequest): Promise<RecentRepository[]> {
  return updateStoredSettings((current) => {
    const recentRepositories = (current.recentRepositories ?? [])
      .filter((item) => repositoryPathKey(item) !== repositoryPathKey(repository))
    return { settings: { ...current, recentRepositories }, result: recentRepositories }
  })
}

async function clearRecentRepositories(): Promise<void> {
  await updateStoredSettings((current) => ({
    settings: { ...current, recentRepositories: [] },
    result: undefined
  }))
}

function parseArguments(template: string, values: Record<string, string>): string[] {
  const tokens = template.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []
  return tokens.map((token) => {
    const unquoted = token.replace(/^("|')|("|')$/g, '')
    return unquoted.replace(/\{(left|right|file)\}/g, (_, key: string) => values[key])
  })
}

async function openExternalDiff(request: ExternalDiffRequest): Promise<void> {
  const { settings } = request
  if (!settings.command.trim()) {
    throw new Error('请先在设置中配置外部对比工具。')
  }
  const tempDirectory = await mkdtemp(join(tmpdir(), 'git-history-viewer-'))
  try {
    const extension = extname(request.file.path)
    const safeName = basename(request.file.path) || `comparison${extension || '.txt'}`
    const left = join(tempDirectory, `before-${safeName}`)
    const right = join(tempDirectory, `after-${safeName}`)
    await writeComparisonFiles(request, left, right)

    await new Promise<void>((resolve, reject) => {
      let started = false
      let child
      try {
        child = spawn(
          settings.command,
          parseArguments(settings.argumentsTemplate, { left, right, file: request.file.path }),
          { detached: true, stdio: 'ignore', windowsHide: false }
        )
      } catch (error) {
        reject(error)
        return
      }
      child.once('error', (error) => {
        if (!started) reject(new Error(`无法启动外部对比工具：${error.message}`))
      })
      child.once('spawn', () => {
        started = true
        child.unref()
        resolve()
      })
    })
  } catch (error) {
    await rm(tempDirectory, { recursive: true, force: true })
    throw error
  }
  setTimeout(() => void rm(tempDirectory, { recursive: true, force: true }), 60 * 60 * 1000)
}

async function exportChangedPaths(repositoryPath: string, hash: string): Promise<boolean> {
  const result = await dialog.showSaveDialog({
    title: '导出完整变更路径',
    defaultPath: `changed-paths-${hash.slice(0, 8)}.txt`,
    filters: [{ name: '文本文件', extensions: ['txt'] }, { name: '所有文件', extensions: ['*'] }]
  })
  if (result.canceled || !result.filePath) return false
  await exportGitChangedPaths(repositoryPath, hash, result.filePath)
  return true
}

// This read-only data tool does not benefit from Chromium GPU compositing enough to justify a GPU process.
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=512')

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    requestRepositoryOpen(parseRepositoryPath(argv))
  })
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return
  const sshSettingsReady = loadStoredSettings().then((storedSettings) => {
    configureSshRepositoryMappings(storedSettings.sshRepositoryMappings ?? [])
    restoreStoredSshPasswords(storedSettings)
  })
  Menu.setApplicationMenu(null)

  ipcMain.handle('app:repository-listener-ready', (event) => {
    if (event.sender !== mainWindow?.webContents) return
    rendererRepositoryListenerReady = true
    sendPendingRepositoryRequest()
  })

  ipcMain.handle('repository:pick-local', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择本地 Git 仓库',
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    await sshSettingsReady
    return openRepository(result.filePaths[0])
  })

  ipcMain.handle('repository:open-recent', async (_, repository: RepositoryOpenRequest) => {
    await sshSettingsReady
    return openRepository(repository)
  })
  ipcMain.handle('repository:choose-clone-parent', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择远程仓库保存位置',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle('repository:clone', (_, url: string, destination: string) => cloneRemoteRepository(url, destination))
  ipcMain.handle('history:load', (event, repositoryPath: string, pathScope: string | undefined, pathScopeKind: RepositoryInfo['pathScopeKind'], filter: HistoryFilter, offset = 0) =>
    runLatestRequest(historyLoadRequests, event.sender.id, (signal) => listCommits(repositoryPath, pathScope, pathScopeKind, filter, signal, offset))
  )
  ipcMain.handle('history:cancel', (event) => abortRequestsForWebContents(event.sender.id))
  ipcMain.handle('history:details', (event, repositoryPath: string, hash: string) =>
    runLatestRequest(historyDetailRequests, event.sender.id, (signal) => getCommitDetails(repositoryPath, hash, signal))
  )
  ipcMain.handle('history:file-changes:start', async (event, repositoryPath: string, pathScope: string | undefined, hash: string) => {
    const senderId = event.sender.id
    fileChangesRequests.get(senderId)?.abort()
    const controller = new AbortController()
    fileChangesRequests.set(senderId, controller)
    try {
      return await startFileChangesScan(repositoryPath, pathScope, hash, controller.signal)
    } catch (error) {
      if (fileChangesRequests.get(senderId) === controller) fileChangesRequests.delete(senderId)
      throw error
    }
  })
  ipcMain.handle('history:file-changes:status', (_, repositoryPath: string, pathScope: string | undefined, hash: string) =>
    getFileChangesStatus(repositoryPath, pathScope, hash)
  )
  ipcMain.handle('history:file-changes-page', (_, repositoryPath: string, pathScope: string | undefined, hash: string, page: number) =>
    getFileChangesPage(repositoryPath, pathScope, hash, page)
  )
  ipcMain.handle('history:export-paths', (_, repositoryPath: string, hash: string) => exportChangedPaths(repositoryPath, hash))
  ipcMain.handle('recent-repositories:list', () => listRecentRepositories())
  ipcMain.handle('recent-repositories:add', (_, repository: RepositoryInfo) => addRecentRepository(repository))
  ipcMain.handle('recent-repositories:remove', (_, repository: RepositoryOpenRequest) => removeRecentRepository(repository))
  ipcMain.handle('recent-repositories:clear', () => clearRecentRepositories())
  ipcMain.handle('ssh-mappings:list', () => listSshRepositoryMappings())
  ipcMain.handle('ssh-mappings:save', (_, mappings: SshRepositoryMapping[]) => saveSshRepositoryMappings(mappings))
  ipcMain.handle('ssh-mappings:set-password', (_, mappingId: string, password: string) =>
    setStoredSshRepositoryPassword(mappingId, password)
  )
  ipcMain.handle('ssh-mappings:test', (_, mapping: SshRepositoryMapping, password?: string) => testSshRepositoryMapping(mapping, password))
  ipcMain.handle('settings:external-diff:get', () => loadExternalDiffSettings())
  ipcMain.handle('settings:external-diff:choose', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择外部对比工具',
      properties: ['openFile'],
      filters: [{ name: '应用程序', extensions: ['exe', 'cmd', 'bat'] }, { name: '所有文件', extensions: ['*'] }]
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle('settings:external-diff:save', (_, settings: ExternalDiffSettings) => saveExternalDiffSettings(settings))
  ipcMain.handle('external-diff:open', (_, request: ExternalDiffRequest) => openExternalDiff(request))
  ipcMain.handle('help:open-git-for-windows', () => shell.openExternal(gitForWindowsInstallUrl))
  ipcMain.handle('app:open-user-data', async () => {
    const userDataDirectory = app.getPath('userData')
    await mkdir(userDataDirectory, { recursive: true })
    const result = await shell.openPath(userDataDirectory)
    if (result) throw new Error(`无法打开应用数据目录：${result}`)
  })

  createWindow()
  mainWindow?.webContents.once('did-finish-load', () => {
    configureFileChangesCacheDirectory(join(app.getPath('userData'), 'file-changes-cache'))
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  closeSshRepositoryConnections()
})
