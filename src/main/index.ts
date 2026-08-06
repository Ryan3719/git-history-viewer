import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { createWriteStream } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import {
  cloneRemoteRepository,
  getCommitDetails,
  getFileChangesPage,
  getRepositoryInfo,
  listCommits,
  writeComparisonFiles
} from './git'
import type {
  ExternalDiffRequest,
  ExternalDiffSettings,
  HistoryFilter,
  RecentRepository,
  RepositoryInfo
} from '../shared/types'

let mainWindow: BrowserWindow | undefined
const historyLoadRequests = new Map<number, AbortController>()
const historyDetailRequests = new Map<number, AbortController>()
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
}

let settingsWriteQueue = Promise.resolve()

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
  historyLoadRequests.delete(senderId)
  historyDetailRequests.delete(senderId)
}

function windowIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.ico')
    : join(app.getAppPath(), 'resources', 'icon.ico')
}

function createWindow(): void {
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
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.once('destroyed', () => abortRequestsForWebContents(webContentsId))

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function repositoryPathKey(repositoryPath: string): string {
  return repositoryPath.replace(/[\\/]+$/, '').toLocaleLowerCase()
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
    byPath.set(repositoryPathKey(repository.path), repository as RecentRepository)
  }
  return [...byPath.values()]
    .sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt))
    .slice(0, maximumRecentRepositories)
}

async function loadStoredSettings(): Promise<StoredSettings> {
  try {
    const data = JSON.parse(await readFile(settingsPath(), 'utf8')) as StoredSettings
    return {
      command: typeof data.command === 'string' ? data.command : undefined,
      argumentsTemplate: typeof data.argumentsTemplate === 'string' ? data.argumentsTemplate : undefined,
      recentRepositories: normalizeRecentRepositories(data.recentRepositories)
    }
  } catch {
    return {}
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

async function listRecentRepositories(): Promise<RecentRepository[]> {
  return (await loadStoredSettings()).recentRepositories ?? []
}

async function addRecentRepository(repository: RepositoryInfo): Promise<RecentRepository[]> {
  return updateStoredSettings((current) => {
    const record: RecentRepository = { ...repository, lastOpenedAt: new Date().toISOString() }
    const recentRepositories = normalizeRecentRepositories([
      record,
      ...(current.recentRepositories ?? []).filter((item) => repositoryPathKey(item.path) !== repositoryPathKey(repository.path))
    ])
    return { settings: { ...current, recentRepositories }, result: recentRepositories }
  })
}

async function removeRecentRepository(repositoryPath: string): Promise<RecentRepository[]> {
  return updateStoredSettings((current) => {
    const recentRepositories = (current.recentRepositories ?? [])
      .filter((item) => repositoryPathKey(item.path) !== repositoryPathKey(repositoryPath))
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

  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', [
      'diff-tree',
      '--root',
      '--no-commit-id',
      '--name-status',
      '-r',
      '-M',
      hash
    ], {
      cwd: repositoryPath,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_PAGER: 'cat'
      }
    })
    const output = createWriteStream(result.filePath)
    const stderr: Buffer[] = []
    let stderrSize = 0
    let finished = false
    let closed = false
    let settled = false

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      child.kill()
      output.destroy()
      reject(error)
    }
    const complete = (): void => {
      if (!settled && finished && closed) {
        settled = true
        resolve()
      }
    }

    child.stdout.pipe(output)
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrSize >= 64 * 1024) return
      stderrSize += chunk.length
      stderr.push(chunk)
    })
    child.once('error', (error) => fail(new Error(`无法启动 git：${error.message}`)))
    output.once('error', (error) => fail(new Error(`无法写入导出文件：${error.message}`)))
    output.once('finish', () => {
      finished = true
      complete()
    })
    child.once('close', (code) => {
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString('utf8').trim()
        fail(new Error(detail || 'git diff-tree 导出失败'))
        return
      }
      closed = true
      complete()
    })
  })

  return true
}

// This read-only data tool does not benefit from Chromium GPU compositing enough to justify a GPU process.
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=512')

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  createWindow()

  ipcMain.handle('repository:pick-local', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择本地 Git 仓库',
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return getRepositoryInfo(result.filePaths[0])
  })

  ipcMain.handle('repository:open-recent', (_, repositoryPath: string) => getRepositoryInfo(repositoryPath))
  ipcMain.handle('repository:choose-clone-parent', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择远程仓库保存位置',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle('repository:clone', (_, url: string, destination: string) => cloneRemoteRepository(url, destination))
  ipcMain.handle('history:load', (event, repositoryPath: string, filter: HistoryFilter, offset = 0) =>
    runLatestRequest(historyLoadRequests, event.sender.id, (signal) => listCommits(repositoryPath, filter, signal, offset))
  )
  ipcMain.handle('history:cancel', (event) => abortRequestsForWebContents(event.sender.id))
  ipcMain.handle('history:details', (event, repositoryPath: string, hash: string) =>
    runLatestRequest(historyDetailRequests, event.sender.id, (signal) => getCommitDetails(repositoryPath, hash, signal))
  )
  ipcMain.handle('history:file-changes-page', (_, repositoryPath: string, hash: string, page: number) =>
    getFileChangesPage(repositoryPath, hash, page)
  )
  ipcMain.handle('history:export-paths', (_, repositoryPath: string, hash: string) => exportChangedPaths(repositoryPath, hash))
  ipcMain.handle('recent-repositories:list', () => listRecentRepositories())
  ipcMain.handle('recent-repositories:add', (_, repository: RepositoryInfo) => addRecentRepository(repository))
  ipcMain.handle('recent-repositories:remove', (_, repositoryPath: string) => removeRecentRepository(repositoryPath))
  ipcMain.handle('recent-repositories:clear', () => clearRecentRepositories())
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
