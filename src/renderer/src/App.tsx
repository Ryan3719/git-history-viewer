import { useCallback, useEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  BookOpen,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  FolderGit2,
  FolderOpen,
  GitBranch,
  Info,
  KeyRound,
  LoaderCircle,
  Moon,
  Network,
  Plus,
  Search,
  Server,
  Settings,
  Sun,
  Trash2,
  X
} from 'lucide-react'
import type {
  CommitDetails,
  CommitSummary,
  ExternalDiffSettings,
  FileChange,
  FileChangesStatus,
  HistoryFilter,
  RecentRepository,
  RepositoryInfo,
  SearchScope,
  SshRepositoryMapping
} from '../../shared/types'

type Theme = 'light' | 'dark'
type GettingStartedMode = 'startup' | 'help' | null
type Notice = { tone: 'error' | 'success'; message: string }

const applicationVersion = '0.0.5'
const gitForWindowsInstallUrl = 'https://git-scm.com/install/windows'

type PathsResizeState = {
  pointerId: number
  startY: number
  startHeight: number
  maximumHeight: number
}

const minimumPathsPanelHeight = 160
const minimumHistoryHeight = 230
const applicationChromeHeight = 104
const historyPageSize = 500
const fileChangesPageSize = 200
const maxCachedFileChangePages = 5

const initialFilter: HistoryFilter = {
  query: '',
  scope: 'all',
  from: '',
  to: '',
  limit: historyPageSize
}

const searchScopes: Array<{ value: SearchScope; label: string }> = [
  { value: 'all', label: '全部字段' },
  { value: 'message', label: '提交信息' },
  { value: 'author', label: '作者' },
  { value: 'path', label: '文件路径' },
  { value: 'hash', label: 'Hash' }
]

function emptySshRepositoryMapping(): SshRepositoryMapping {
  return {
    id: '',
    localPath: '',
    host: '',
    port: 22,
    username: '',
    remotePath: '',
    identityFile: '',
    authMethod: 'password'
  }
}

function repositoryDisplayPath(repository: RepositoryInfo): string {
  return repository.displayPath ?? repository.path
}

function sshMappingSummary(mapping: SshRepositoryMapping): string {
  if (!mapping.localPath) return `自动识别 ${mapping.host} 的网络盘，服务器目录使用 $HOME`
  return `${mapping.username}@${mapping.host}:${mapping.remotePath}`
}

function sshMappingLabel(mapping: SshRepositoryMapping): string {
  return mapping.localPath || `${mapping.username}@${mapping.host}`
}

function sshAuthenticationMethodLabel(mapping: SshRepositoryMapping): string {
  if (mapping.authMethod === 'password') return '密码认证'
  if (mapping.authMethod === 'privateKey') return '指定私钥'
  return '系统 SSH Agent'
}

function formatDate(value: string): string {
  if (!value) return '---'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

function repoDirectoryName(url: string): string {
  const clean = url.trim().replace(/[\\/]+$/, '')
  const candidate = clean.split(/[\\/:]/).at(-1)?.replace(/\.git$/i, '')
  return candidate?.replace(/[^a-zA-Z0-9._-]/g, '-') || 'repository'
}

function externalDiffArgumentsTemplate(command: string): string {
  const executable = command.trim().split(/[\\/]/).at(-1)?.toLocaleLowerCase()
  if (executable === 'code' || executable === 'code.exe' || executable === 'code-insiders' || executable === 'code-insiders.exe') {
    return '--diff "{left}" "{right}"'
  }
  return '"{left}" "{right}"'
}

function changeStatusLabel(status: FileChange['status']): string {
  const labels: Record<FileChange['status'], string> = {
    A: '新增',
    M: '修改',
    D: '删除',
    R: '重命名',
    C: '复制',
    T: '类型变更',
    U: '未合并',
    X: '未知'
  }
  return labels[status]
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === 'AbortError' ||
    error.message.includes('AbortError') ||
    error.message.includes('Git 读取已取消')
  )
}

function HistoryTable({
  commits,
  selectedHash,
  onSelect
}: {
  commits: CommitSummary[]
  selectedHash: string | null
  onSelect: (hash: string) => void
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 38,
    overscan: 14
  })
  const rows = virtualizer.getVirtualItems()

  return (
    <section className="log-section" aria-label="提交历史">
      <div className="table-header" role="row">
        <span>图</span>
        <span>Revision</span>
        <span>变更</span>
        <span>Author</span>
        <span>Date</span>
        <span>Message</span>
      </div>
      <div ref={scrollRef} className="log-table-scroll" role="grid" aria-label="Git 提交历史">
        {commits.length === 0 ? (
          <div className="empty-table">没有符合当前筛选条件的提交。</div>
        ) : (
          <div className="virtual-table" style={{ height: virtualizer.getTotalSize() }}>
            {rows.map((row) => {
              const commit = commits[row.index]
              const selected = selectedHash === commit.hash
              return (
                <button
                  key={commit.hash}
                  className={`log-row ${selected ? 'is-selected' : ''}`}
                  style={{ transform: `translateY(${row.start}px)` }}
                  type="button"
                  role="row"
                  onClick={() => onSelect(commit.hash)}
                  title="单击查看变更路径"
                >
                  <span className="commit-graph" aria-hidden="true"><i /><b /></span>
                  <span className="hash-cell"><code>{commit.shortHash}</code></span>
                  <span className="actions-cell">{commit.parents.length > 1 ? '合并' : '提交'}</span>
                  <span className="author-cell">{commit.authorName}</span>
                  <span className="date-cell">{formatDate(commit.date)}</span>
                  <span className="message-cell">
                    <strong>{commit.subject || '(无提交说明)'}</strong>
                    {commit.refs.length > 0 && (
                      <small>{commit.refs.slice(0, 2).join('  ')}</small>
                    )}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}

function FileList({
  pages,
  total,
  loading,
  selectedFile,
  onSelect,
  onCompare,
  onRequestPage
}: {
  pages: Map<number, FileChange[]>
  total: number
  loading: boolean
  selectedFile: FileChange | null
  onSelect: (file: FileChange) => void
  onCompare: (file: FileChange) => void
  onRequestPage: (page: number) => void
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 34,
    overscan: 10
  })
  const rows = virtualizer.getVirtualItems()
  const visiblePageKey = [...new Set(rows.map((row) => Math.floor(row.index / fileChangesPageSize)))].join(',')

  useEffect(() => {
    if (!visiblePageKey) return
    visiblePageKey.split(',').forEach((value) => onRequestPage(Number(value)))
  }, [onRequestPage, visiblePageKey])

  return (
    <div ref={scrollRef} className="file-list" role="list" aria-label="变更路径">
      {total === 0 ? (
        loading ? (
          <div className="file-list-loading" role="status"><LoaderCircle className="spin" size={18} />正在读取变更文件...</div>
        ) : (
          <div className="empty-files">该提交没有文件变更。</div>
        )
      ) : (
        <div className="file-virtual-list" style={{ height: virtualizer.getTotalSize() }}>
          {rows.map((row) => {
            const page = Math.floor(row.index / fileChangesPageSize)
            const file = pages.get(page)?.[row.index % fileChangesPageSize]
            if (!file) return null
            return (
              <button
                key={`${file.status}-${file.path}-${file.previousPath ?? ''}`}
                type="button"
                role="listitem"
                className={`file-row ${selectedFile?.path === file.path ? 'is-active' : ''}`}
                style={{ transform: `translateY(${row.start}px)` }}
                onClick={() => onSelect(file)}
                onDoubleClick={() => onCompare(file)}
                title={`${file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}，双击在外部工具中对比`}
              >
                <span className="file-path">{file.path}</span>
                <span className={`file-action status-${file.status}`}>
                  <span className={`change-badge status-${file.status}`}>{file.status}</span>
                  {changeStatusLabel(file.status)}
                </span>
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function App(): React.JSX.Element {
  const appShellRef = useRef<HTMLElement>(null)
  const helpMenuRef = useRef<HTMLDivElement>(null)
  const pathsResizeRef = useRef<PathsResizeState | null>(null)
  const historyRequestRef = useRef(0)
  const historyOffsetRef = useRef(0)
  const repositoryOpenRequestRef = useRef(0)
  const commitsRef = useRef<CommitSummary[]>([])
  const filePageRequestsRef = useRef(new Set<string>())
  const filePageGenerationRef = useRef(0)
  const [repository, setRepository] = useState<RepositoryInfo | null>(null)
  const [recentRepositories, setRecentRepositories] = useState<RecentRepository[]>([])
  const [filter, setFilter] = useState<HistoryFilter>(initialFilter)
  const [commits, setCommits] = useState<CommitSummary[]>([])
  const [selectedHash, setSelectedHash] = useState<string | null>(null)
  const [details, setDetails] = useState<CommitDetails | null>(null)
  const [fileChangesStatus, setFileChangesStatus] = useState<FileChangesStatus | null>(null)
  const [filePages, setFilePages] = useState<Map<number, FileChange[]>>(() => new Map())
  const [selectedFile, setSelectedFile] = useState<FileChange | null>(null)
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('theme') as Theme) || 'light')
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [historyHasMore, setHistoryHasMore] = useState(false)
  const [loadingDetails, setLoadingDetails] = useState(false)
  const [busyMessage, setBusyMessage] = useState('')
  const [error, setError] = useState('')
  const [remoteOpen, setRemoteOpen] = useState(false)
  const [clearRecentConfirmOpen, setClearRecentConfirmOpen] = useState(false)
  const [clearingRecentRepositories, setClearingRecentRepositories] = useState(false)
  const [remoteUrl, setRemoteUrl] = useState('')
  const [cloneDestination, setCloneDestination] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [helpMenuOpen, setHelpMenuOpen] = useState(false)
  const [sshMappingsOpen, setSshMappingsOpen] = useState(false)
  const [sshMappings, setSshMappings] = useState<SshRepositoryMapping[]>([])
  const [sshMappingDraft, setSshMappingDraft] = useState<SshRepositoryMapping | null>(null)
  const [sshMappingPassword, setSshMappingPassword] = useState('')
  const [showSshMappingPassword, setShowSshMappingPassword] = useState(false)
  const [rememberSshMappingPassword, setRememberSshMappingPassword] = useState(true)
  const [sshMappingNotice, setSshMappingNotice] = useState<Notice | null>(null)
  const [testingSshMapping, setTestingSshMapping] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [gettingStartedMode, setGettingStartedMode] = useState<GettingStartedMode>(() => (
    localStorage.getItem('getting-started-dismissed') === 'true' ? null : 'startup'
  ))
  const [dismissGettingStarted, setDismissGettingStarted] = useState(() => localStorage.getItem('getting-started-dismissed') === 'true')
  const [externalSettings, setExternalSettings] = useState<ExternalDiffSettings>({
    command: '',
    argumentsTemplate: '"{left}" "{right}"'
  })
  const [settingsNotice, setSettingsNotice] = useState('')
  const [pathsPanelHeight, setPathsPanelHeight] = useState<number | null>(null)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('theme', theme)
  }, [theme])

  useEffect(() => {
    commitsRef.current = commits
  }, [commits])

  useEffect(() => {
    let cancelled = false
    void window.gitHistory.listRecentRepositories().then((items) => {
      if (!cancelled) setRecentRepositories(items)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!helpMenuOpen) return

    const closeWhenClickingOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !helpMenuRef.current?.contains(event.target)) {
        setHelpMenuOpen(false)
      }
    }
    const closeWithEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setHelpMenuOpen(false)
    }

    document.addEventListener('pointerdown', closeWhenClickingOutside)
    document.addEventListener('keydown', closeWithEscape)
    return () => {
      document.removeEventListener('pointerdown', closeWhenClickingOutside)
      document.removeEventListener('keydown', closeWithEscape)
    }
  }, [helpMenuOpen])

  const clampPathsPanelHeight = (height: number): number => {
    const appHeight = appShellRef.current?.clientHeight ?? window.innerHeight
    const maximumHeight = Math.max(minimumPathsPanelHeight, appHeight - applicationChromeHeight - minimumHistoryHeight)
    return Math.min(Math.max(height, minimumPathsPanelHeight), maximumHeight)
  }

  useEffect(() => {
    const clampForWindowResize = (): void => {
      setPathsPanelHeight((current) => (current === null ? null : clampPathsPanelHeight(current)))
    }
    window.addEventListener('resize', clampForWindowResize)
    return () => window.removeEventListener('resize', clampForWindowResize)
  }, [])

  const loadHistory = useCallback(async (append = false) => {
    if (!repository) return
    const requestId = ++historyRequestRef.current
    const previous = append ? commitsRef.current : []
    const offset = append ? historyOffsetRef.current : 0
    setLoadingHistory(true)
    setError('')
    try {
      const result = await window.gitHistory.loadHistory(repository.path, filter, offset)
      if (requestId !== historyRequestRef.current) return
      const next = result.commits
      const knownHashes = new Set(previous.map((commit) => commit.hash))
      const combined = append ? [...previous, ...next.filter((commit) => !knownHashes.has(commit.hash))] : next
      setCommits(combined)
      historyOffsetRef.current = result.nextOffset
      setHistoryHasMore(result.hasMore)
      setSelectedHash((current) => (current && combined.some((item) => item.hash === current) ? current : (combined[0]?.hash ?? null)))
    } catch (loadError) {
      if (requestId !== historyRequestRef.current || (loadError instanceof Error && loadError.name === 'AbortError')) return
      setError(loadError instanceof Error ? loadError.message : '无法读取提交历史。')
      if (!append) {
        setCommits([])
        setSelectedHash(null)
        historyOffsetRef.current = 0
      }
      setHistoryHasMore(false)
    } finally {
      if (requestId === historyRequestRef.current) setLoadingHistory(false)
    }
  }, [filter, repository])

  useEffect(() => {
    if (!repository) return
    const timer = window.setTimeout(() => void loadHistory(false), filter.query ? 320 : 0)
    return () => window.clearTimeout(timer)
  }, [filter, loadHistory, repository])

  useEffect(() => {
    filePageGenerationRef.current += 1
    filePageRequestsRef.current.clear()
    setFilePages(new Map())
    if (!repository || !selectedHash) {
      setDetails(null)
      setFileChangesStatus(null)
      setSelectedFile(null)
      return
    }
    let cancelled = false
    setDetails(null)
    setFileChangesStatus(null)
    setSelectedFile(null)
    setLoadingDetails(true)
    void window.gitHistory
      .getCommitDetails(repository.path, selectedHash)
      .then((next) => {
        if (cancelled) return
        setDetails(next)
        void window.gitHistory
          .startFileChangesScan(repository.path, next.hash)
          .then((status) => {
            if (!cancelled) setFileChangesStatus(status)
          })
          .catch((scanError) => {
            if (!cancelled && !isAbortError(scanError)) {
              setError(scanError instanceof Error ? scanError.message : '无法读取变更路径。')
            }
          })
      })
      .catch((detailsError) => {
        if (!cancelled && !isAbortError(detailsError)) {
          setError(detailsError instanceof Error ? detailsError.message : '无法读取提交详情。')
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingDetails(false)
      })
    return () => {
      cancelled = true
    }
  }, [repository, selectedHash])

  useEffect(() => {
    if (!repository || !details || fileChangesStatus?.complete) return
    let cancelled = false
    let timer: number | undefined

    const pollStatus = async (): Promise<void> => {
      try {
        const next = await window.gitHistory.getFileChangesStatus(repository.path, details.hash)
        if (cancelled) return
        setFileChangesStatus(next)
        if (!next.complete) timer = window.setTimeout(() => void pollStatus(), 250)
      } catch (statusError) {
        if (!cancelled && !isAbortError(statusError)) {
          setError(statusError instanceof Error ? statusError.message : '无法读取变更路径。')
        }
      }
    }

    void pollStatus()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [details, fileChangesStatus?.complete, repository])

  const requestFileChangesPage = useCallback((page: number): void => {
    if (!repository || !details) return
    const generation = filePageGenerationRef.current
    const requestKey = `${generation}:${page}`
    if (filePageRequestsRef.current.has(requestKey)) return
    filePageRequestsRef.current.add(requestKey)

    void window.gitHistory
      .getFileChangesPage(repository.path, details.hash, page)
        .then((result) => {
          if (generation !== filePageGenerationRef.current) return
          setFileChangesStatus({
            scannedCount: result.scannedCount,
            availableCount: result.availableCount,
            complete: result.complete
          })
          setFilePages((current) => {
          const next = new Map(current)
          next.delete(result.page)
          next.set(result.page, result.changes)
          while (next.size > maxCachedFileChangePages) {
            const oldest = next.keys().next().value
            if (oldest === undefined) break
            next.delete(oldest)
          }
          return next
        })
        setSelectedFile((current) => current ?? result.changes[0] ?? null)
      })
      .catch((pageError) => {
        if (generation === filePageGenerationRef.current) {
          setError(pageError instanceof Error ? pageError.message : '无法读取变更路径。')
        }
      })
      .finally(() => filePageRequestsRef.current.delete(requestKey))
  }, [details, repository])

  const selectRepository = useCallback((repo: RepositoryInfo): void => {
    historyRequestRef.current += 1
    historyOffsetRef.current = 0
    filePageGenerationRef.current += 1
    filePageRequestsRef.current.clear()
    setCommits([])
    setHistoryHasMore(false)
    setSelectedHash(null)
    setDetails(null)
    setFileChangesStatus(null)
    setFilePages(new Map())
    setSelectedFile(null)
    setLoadingHistory(false)
    setRepository(repo)
    setFilter(initialFilter)
    void window.gitHistory.addRecentRepository(repo).then(setRecentRepositories).catch((saveError) => {
      setError(saveError instanceof Error ? saveError.message : '无法保存最近打开的项目。')
    })
  }, [])

  const closeRepository = (): void => {
    historyRequestRef.current += 1
    historyOffsetRef.current = 0
    filePageGenerationRef.current += 1
    filePageRequestsRef.current.clear()
    setCommits([])
    setHistoryHasMore(false)
    setSelectedHash(null)
    setDetails(null)
    setFileChangesStatus(null)
    setFilePages(new Map())
    setSelectedFile(null)
    setLoadingHistory(false)
    setLoadingDetails(false)
    setError('')
    setRepository(null)
    void window.gitHistory.cancelHistoryRequests()
  }

  const startPathsResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    const panel = event.currentTarget.parentElement
    if (!panel) return
    const startHeight = panel.getBoundingClientRect().height
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    pathsResizeRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight,
      maximumHeight: clampPathsPanelHeight(Number.MAX_SAFE_INTEGER)
    }
    setPathsPanelHeight(startHeight)
  }

  const resizePaths = (event: React.PointerEvent<HTMLDivElement>): void => {
    const resizeState = pathsResizeRef.current
    if (!resizeState || resizeState.pointerId !== event.pointerId) return
    const nextHeight = resizeState.startHeight - (event.clientY - resizeState.startY)
    setPathsPanelHeight(Math.min(Math.max(nextHeight, minimumPathsPanelHeight), resizeState.maximumHeight))
  }

  const finishPathsResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (pathsResizeRef.current?.pointerId !== event.pointerId) return
    pathsResizeRef.current = null
  }

  const resizePathsWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    const panel = event.currentTarget.parentElement
    const currentHeight = pathsPanelHeight ?? panel?.getBoundingClientRect().height ?? minimumPathsPanelHeight
    const step = event.shiftKey ? 48 : 24
    event.preventDefault()
    setPathsPanelHeight(clampPathsPanelHeight(currentHeight + (event.key === 'ArrowUp' ? step : -step)))
  }

  const openLocalRepository = async (): Promise<void> => {
    setError('')
    try {
      const repo = await window.gitHistory.pickLocalRepository()
      if (repo) {
        selectRepository(repo)
      }
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : '所选目录不是可读取的 Git 仓库。')
    }
  }

  const openRepositoryPath = useCallback(async (repositoryPath: string, failureMessage: string): Promise<void> => {
    const requestId = ++repositoryOpenRequestRef.current
    setError('')
    try {
      const repo = await window.gitHistory.openRecentRepository(repositoryPath)
      if (requestId === repositoryOpenRequestRef.current) selectRepository(repo)
    } catch (openError) {
      if (requestId === repositoryOpenRequestRef.current) {
        setError(openError instanceof Error ? openError.message : failureMessage)
      }
    }
  }, [selectRepository])

  const openRecentRepository = async (recent: RecentRepository): Promise<void> => {
    await openRepositoryPath(recent.path, '无法打开该项目。请确认仓库路径仍然可用。')
  }

  useEffect(() => {
    const removeListener = window.gitHistory.onRepositoryRequested((repositoryPath) => {
      void openRepositoryPath(repositoryPath, '所选目录不是可读取的 Git 仓库。')
    })
    void window.gitHistory.notifyRepositoryListenerReady()
    return removeListener
  }, [openRepositoryPath])

  const removeRecentRepository = async (repositoryPath: string): Promise<void> => {
    try {
      setRecentRepositories(await window.gitHistory.removeRecentRepository(repositoryPath))
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : '无法移除最近打开的项目。')
    }
  }

  const clearRecentRepositories = async (): Promise<void> => {
    setClearingRecentRepositories(true)
    try {
      await window.gitHistory.clearRecentRepositories()
      setRecentRepositories([])
      setClearRecentConfirmOpen(false)
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : '无法清空最近打开的项目。')
    } finally {
      setClearingRecentRepositories(false)
    }
  }

  const chooseCloneDestination = async (): Promise<void> => {
    const parent = await window.gitHistory.chooseCloneParent()
    if (!parent) return
    setCloneDestination(`${parent}\\${repoDirectoryName(remoteUrl)}`)
  }

  const chooseExternalDiffTool = async (): Promise<void> => {
    const command = await window.gitHistory.chooseExternalDiffTool()
    if (command) {
      setExternalSettings({
        command,
        argumentsTemplate: externalDiffArgumentsTemplate(command)
      })
    }
  }

  const importRemoteRepository = async (): Promise<void> => {
    if (!remoteUrl.trim() || !cloneDestination.trim()) {
      setError('请输入远程仓库地址并选择保存位置。')
      return
    }
    setBusyMessage('正在导入远程仓库...')
    setError('')
    try {
      const repo = await window.gitHistory.cloneRemoteRepository(remoteUrl.trim(), cloneDestination.trim())
      selectRepository(repo)
      setRemoteOpen(false)
    } catch (cloneError) {
      setError(cloneError instanceof Error ? cloneError.message : '远程仓库导入失败。')
    } finally {
      setBusyMessage('')
    }
  }

  const clearFilter = (): void => setFilter(initialFilter)

  const openSettings = async (): Promise<void> => {
    setExternalSettings(await window.gitHistory.getExternalDiffSettings())
    setSettingsNotice('')
    setSettingsOpen(true)
  }

  const openSshMappings = async (): Promise<void> => {
    try {
      setSshMappings(await window.gitHistory.listSshRepositoryMappings())
      setSshMappingDraft(null)
      setSshMappingPassword('')
      setShowSshMappingPassword(false)
      setRememberSshMappingPassword(true)
      setSshMappingNotice(null)
      setSshMappingsOpen(true)
    } catch (mappingError) {
      setError(mappingError instanceof Error ? mappingError.message : '无法读取 SSH 映射配置。')
    }
  }

  const validateSshMappingDraft = (): SshRepositoryMapping | null => {
    if (!sshMappingDraft) return null
    const mapping: SshRepositoryMapping = {
      ...sshMappingDraft,
      id: sshMappingDraft.id || crypto.randomUUID(),
      localPath: sshMappingDraft.localPath.trim(),
      host: sshMappingDraft.host.trim(),
      port: Math.floor(Number(sshMappingDraft.port)),
      username: sshMappingDraft.username.trim(),
      remotePath: sshMappingDraft.remotePath.trim(),
      identityFile: sshMappingDraft.identityFile.trim(),
      authMethod: sshMappingDraft.authMethod
    }
    if (!mapping.host || !mapping.username) {
      setSshMappingNotice({ tone: 'error', message: '请填写服务器主机和 SSH 用户名。' })
      return null
    }
    if (Boolean(mapping.localPath) !== Boolean(mapping.remotePath)) {
      setSshMappingNotice({ tone: 'error', message: 'Windows 映射路径和服务器路径前缀需同时填写，或同时留空以使用自动识别。' })
      return null
    }
    if (mapping.remotePath && !mapping.remotePath.startsWith('/')) {
      setSshMappingNotice({ tone: 'error', message: '服务器路径必须是以 / 开头的绝对路径。' })
      return null
    }
    if (!Number.isInteger(mapping.port) || mapping.port < 1 || mapping.port > 65535) {
      setSshMappingNotice({ tone: 'error', message: 'SSH 端口必须在 1 到 65535 之间。' })
      return null
    }
    if (mapping.authMethod === 'privateKey' && !mapping.identityFile) {
      setSshMappingNotice({ tone: 'error', message: '指定私钥认证需要选择 SSH 私钥文件。' })
      return null
    }
    if (mapping.authMethod === 'password' && !sshMappingPassword && !sshMappings.some((item) => item.id === mapping.id)) {
      setSshMappingNotice({ tone: 'error', message: '请输入 SSH 密码。勾选“记住密码”后会使用 Windows 加密保存。' })
      return null
    }
    const duplicate = sshMappings.some((item) => {
      if (item.id === mapping.id) return false
      if (!mapping.localPath && !item.localPath) {
        return item.host.toLocaleLowerCase() === mapping.host.toLocaleLowerCase() &&
          item.username.toLocaleLowerCase() === mapping.username.toLocaleLowerCase() &&
          item.port === mapping.port
      }
      return Boolean(mapping.localPath) && item.localPath.replace(/[\\/]+$/, '').toLocaleLowerCase() === mapping.localPath.replace(/[\\/]+$/, '').toLocaleLowerCase()
    })
    if (duplicate) {
      setSshMappingNotice({ tone: 'error', message: mapping.localPath ? '该映射盘路径已经配置。请编辑已有规则。' : '该 SSH 服务器已经配置为自动识别。请编辑已有规则。' })
      return null
    }
    return mapping
  }

  const saveSshMapping = async (): Promise<void> => {
    const mapping = validateSshMappingDraft()
    if (!mapping) return
    try {
      const next = sshMappings.some((item) => item.id === mapping.id)
        ? sshMappings.map((item) => (item.id === mapping.id ? mapping : item))
        : [...sshMappings, mapping]
      const savedMappings = await window.gitHistory.saveSshRepositoryMappings(next)
      if (mapping.authMethod === 'password' && (sshMappingPassword || !rememberSshMappingPassword)) {
        await window.gitHistory.setSshRepositoryPassword(mapping.id, sshMappingPassword, rememberSshMappingPassword)
      }
      setSshMappings(savedMappings)
      setSshMappingDraft(null)
      setSshMappingPassword('')
      setShowSshMappingPassword(false)
      setRememberSshMappingPassword(true)
      setSshMappingNotice({ tone: 'success', message: sshMappingPassword && rememberSshMappingPassword ? 'SSH 映射和加密密码已保存。' : 'SSH 映射已保存。右键该映射盘中的目录会自动使用服务器 Git。' })
    } catch (mappingError) {
      setSshMappingNotice({ tone: 'error', message: mappingError instanceof Error ? mappingError.message : '无法保存 SSH 映射。' })
    }
  }

  const testSshMapping = async (): Promise<void> => {
    const mapping = validateSshMappingDraft()
    if (!mapping) return
    setTestingSshMapping(true)
    setSshMappingNotice(null)
    try {
      await window.gitHistory.testSshRepositoryMapping(mapping, sshMappingPassword || undefined)
      setSshMappingNotice({ tone: 'success', message: 'SSH 连接成功，服务器可以执行 Git。' })
    } catch (mappingError) {
      setSshMappingNotice({ tone: 'error', message: mappingError instanceof Error ? mappingError.message : 'SSH 连接测试失败。' })
    } finally {
      setTestingSshMapping(false)
    }
  }

  const removeSshMapping = async (mapping: SshRepositoryMapping): Promise<void> => {
    if (!window.confirm(`移除 ${mapping.localPath} 的 SSH 映射？该操作不会影响服务器仓库。`)) return
    try {
      const next = await window.gitHistory.saveSshRepositoryMappings(sshMappings.filter((item) => item.id !== mapping.id))
      setSshMappings(next)
      setSshMappingNotice({ tone: 'success', message: 'SSH 映射已移除。' })
    } catch (mappingError) {
      setSshMappingNotice({ tone: 'error', message: mappingError instanceof Error ? mappingError.message : '无法移除 SSH 映射。' })
    }
  }

  const chooseSshIdentityFile = async (): Promise<void> => {
    if (!sshMappingDraft) return
    const identityFile = await window.gitHistory.chooseSshIdentityFile()
    if (identityFile) setSshMappingDraft({ ...sshMappingDraft, identityFile })
  }

  const closeGettingStarted = (): void => {
    setGettingStartedMode(null)
  }

  const updateGettingStartedDismissal = (dismiss: boolean): void => {
    setDismissGettingStarted(dismiss)
    if (dismiss) {
      localStorage.setItem('getting-started-dismissed', 'true')
    } else {
      localStorage.removeItem('getting-started-dismissed')
    }
  }

  const saveSettings = async (): Promise<void> => {
    await window.gitHistory.saveExternalDiffSettings(externalSettings)
    setSettingsNotice('')
    setSettingsOpen(false)
  }

  const openExternalComparison = async (file: FileChange): Promise<void> => {
    if (!repository || !details) return
    setBusyMessage('正在启动外部对比工具...')
    try {
      const settings = await window.gitHistory.getExternalDiffSettings()
      if (!settings.command.trim()) {
        setExternalSettings(settings)
        setSettingsNotice('请先选择或填写外部对比工具的程序路径。')
        setSettingsOpen(true)
        return
      }
      await window.gitHistory.openExternalDiff({
        repositoryPath: repository.path,
        commitHash: details.hash,
        parentHash: details.parents[0],
        file,
        settings
      })
    } catch (externalError) {
      setError(externalError instanceof Error ? externalError.message : '无法启动外部对比工具。')
    } finally {
      setBusyMessage('')
    }
  }

  const openUserDataDirectory = async (): Promise<void> => {
    try {
      await window.gitHistory.openUserDataDirectory()
    } catch (openDirectoryError) {
      setError(openDirectoryError instanceof Error ? openDirectoryError.message : '无法打开应用数据目录。')
    }
  }

  const activeFilterCount = Number(Boolean(filter.query)) + Number(Boolean(filter.from)) + Number(Boolean(filter.to))
  const visibleFileCount = fileChangesStatus
    ? (fileChangesStatus.complete ? fileChangesStatus.scannedCount : fileChangesStatus.availableCount)
    : 0
  const fileChangesLoading = Boolean(details) && !fileChangesStatus?.complete
  const appShellStyle = pathsPanelHeight === null
    ? undefined
    : ({ '--paths-panel-height': `${pathsPanelHeight}px` } as React.CSSProperties)
  const settingsDialog = settingsOpen ? (
    <div className="modal-backdrop" role="presentation">
      <section className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="modal-heading"><div><h2 id="settings-title">外部对比工具</h2></div><button className="icon-button" type="button" aria-label="关闭" title="关闭" onClick={() => setSettingsOpen(false)}><X size={18} /></button></div>
        <label>程序路径<div className="path-picker"><input value={externalSettings.command} onChange={(event) => { const command = event.target.value; setExternalSettings({ command, argumentsTemplate: externalDiffArgumentsTemplate(command) }) }} placeholder="C:\\Program Files\\WinMerge\\WinMergeU.exe" autoFocus /><button className="secondary-button compact" type="button" onClick={() => void chooseExternalDiffTool()}>浏览</button></div></label>
        {settingsNotice && <div className="inline-error" role="alert">{settingsNotice}</div>}
        <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setSettingsOpen(false)}>取消</button><button className="primary-button" type="button" onClick={() => void saveSettings()}><Check size={17} />保存</button></div>
      </section>
    </div>
  ) : null
  const sshMappingsDialog = sshMappingsOpen ? (
    <div className="modal-backdrop" role="presentation">
      <section className="modal ssh-mappings-modal" role="dialog" aria-modal="true" aria-labelledby="ssh-mappings-title">
        <div className="modal-heading">
          <div><h2 id="ssh-mappings-title">SSH 服务器</h2><p>配置后，右键网络盘中的 Git 仓库会自动在服务器执行 Git。</p></div>
          <button className="icon-button" type="button" aria-label="关闭" title="关闭" onClick={() => setSshMappingsOpen(false)}><X size={18} /></button>
        </div>
        {sshMappingDraft ? (
          <div className="ssh-mapping-form">
            <div className="ssh-mapping-grid">
              <label>Windows 映射路径（可选）<input value={sshMappingDraft.localPath} onChange={(event) => setSshMappingDraft({ ...sshMappingDraft, localPath: event.target.value })} placeholder="留空时自动识别网络盘" autoFocus /></label>
              <label>服务器主机（必填）<input value={sshMappingDraft.host} onChange={(event) => setSshMappingDraft({ ...sshMappingDraft, host: event.target.value })} placeholder="192.168.160.76" /></label>
              <label>SSH 用户名（必填）<input value={sshMappingDraft.username} onChange={(event) => setSshMappingDraft({ ...sshMappingDraft, username: event.target.value })} placeholder="sunjx" /></label>
              <label>SSH 端口<input type="number" min="1" max="65535" value={sshMappingDraft.port} onChange={(event) => setSshMappingDraft({ ...sshMappingDraft, port: Number(event.target.value) })} /></label>
              <label className="wide">服务器路径前缀（可选）<input value={sshMappingDraft.remotePath} onChange={(event) => setSshMappingDraft({ ...sshMappingDraft, remotePath: event.target.value })} placeholder="留空时使用 SSH 用户主目录" /></label>
              <label className="wide">认证方式<select value={sshMappingDraft.authMethod} onChange={(event) => setSshMappingDraft({ ...sshMappingDraft, authMethod: event.target.value as SshRepositoryMapping['authMethod'] })}><option value="password">密码</option><option value="privateKey">指定私钥</option><option value="agent">系统 SSH Agent</option></select></label>
              {sshMappingDraft.authMethod === 'password' ? (
                <><label className="wide">SSH 密码<div className="password-input"><input type={showSshMappingPassword ? 'text' : 'password'} value={sshMappingPassword} onChange={(event) => setSshMappingPassword(event.target.value)} placeholder="输入服务器 SSH 账号密码" autoComplete="current-password" /><button className="icon-button password-visibility-button" type="button" aria-label={showSshMappingPassword ? '隐藏 SSH 密码' : '显示 SSH 密码'} title={showSshMappingPassword ? '隐藏密码' : '显示密码'} onClick={() => setShowSshMappingPassword(!showSshMappingPassword)}>{showSshMappingPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label><label className="ssh-password-remember wide"><input type="checkbox" checked={rememberSshMappingPassword} onChange={(event) => setRememberSshMappingPassword(event.target.checked)} /><span>在此 Windows 帐户中记住密码</span></label></>
              ) : sshMappingDraft.authMethod === 'privateKey' ? (
                <label className="wide">SSH 私钥<div className="path-picker"><input value={sshMappingDraft.identityFile} onChange={(event) => setSshMappingDraft({ ...sshMappingDraft, identityFile: event.target.value })} placeholder="C:\\Users\\用户名\\.ssh\\id_ed25519" /><button className="secondary-button compact" type="button" onClick={() => void chooseSshIdentityFile()}>浏览</button></div></label>
              ) : null}
            </div>
            <div className="ssh-mapping-help"><KeyRound size={16} aria-hidden="true" /><span>{sshMappingDraft.localPath ? '自定义路径映射：两个路径必须同时填写。' : sshMappingDraft.authMethod === 'password' ? (rememberSshMappingPassword ? '自动识别网络盘，密码会由 Windows 加密保护，可在下次启动时自动使用。' : '自动识别网络盘，密码不会保存，退出软件后需要重新输入。') : sshMappingDraft.authMethod === 'privateKey' ? '自动识别网络盘；私钥文件路径会保存。' : '自动识别网络盘，使用系统 SSH Agent 中已加载的密钥。'}</span></div>
            {sshMappingNotice && <div className={`ssh-mapping-notice ${sshMappingNotice.tone}`} role={sshMappingNotice.tone === 'error' ? 'alert' : 'status'}>{sshMappingNotice.message}</div>}
            <div className="modal-actions">
              <button className="secondary-button" type="button" onClick={() => { setSshMappingDraft(null); setSshMappingPassword(''); setShowSshMappingPassword(false); setRememberSshMappingPassword(true); setSshMappingNotice(null) }}>返回</button>
              <button className="secondary-button" type="button" disabled={testingSshMapping} onClick={() => void testSshMapping()}>{testingSshMapping ? <LoaderCircle className="spin" size={17} /> : <Network size={17} />}测试连接</button>
              <button className="primary-button" type="button" disabled={testingSshMapping} onClick={() => void saveSshMapping()}><Check size={17} />保存映射</button>
            </div>
          </div>
        ) : (
          <>
            <div className="ssh-mapping-list" role="list" aria-label="SSH 映射列表">
              {sshMappings.length === 0 ? (
                <div className="ssh-mapping-empty"><Server size={20} aria-hidden="true" /><span>尚未配置 SSH 服务器。添加后，右键网络盘中的目录将直接使用服务器 Git。</span></div>
              ) : sshMappings.map((mapping) => (
                <div className="ssh-mapping-row" role="listitem" key={mapping.id}>
                  <div className="ssh-mapping-summary"><strong>{sshMappingLabel(mapping)}</strong><span title={sshMappingSummary(mapping)}>{sshMappingSummary(mapping)}</span><small title={mapping.authMethod === 'privateKey' ? mapping.identityFile : undefined}>{sshAuthenticationMethodLabel(mapping)}</small></div>
                  <div className="ssh-mapping-row-actions"><button className="secondary-button compact" type="button" onClick={() => { setSshMappingDraft({ ...mapping }); setSshMappingPassword(''); setShowSshMappingPassword(false); setRememberSshMappingPassword(true); setSshMappingNotice(null) }}>编辑</button><button className="icon-button" type="button" aria-label={`移除 ${mapping.localPath} 的 SSH 映射`} title="移除映射" onClick={() => void removeSshMapping(mapping)}><X size={17} /></button></div>
                </div>
              ))}
            </div>
            {sshMappingNotice && <div className={`ssh-mapping-notice ${sshMappingNotice.tone}`} role={sshMappingNotice.tone === 'error' ? 'alert' : 'status'}>{sshMappingNotice.message}</div>}
            <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setSshMappingsOpen(false)}>关闭</button><button className="primary-button" type="button" onClick={() => { setSshMappingDraft(emptySshRepositoryMapping()); setSshMappingPassword(''); setShowSshMappingPassword(false); setRememberSshMappingPassword(true); setSshMappingNotice(null) }}><Plus size={17} />添加映射</button></div>
          </>
        )}
      </section>
    </div>
  ) : null
  const aboutDialog = aboutOpen ? (
    <div className="modal-backdrop" role="presentation">
      <section className="modal about-modal" role="dialog" aria-modal="true" aria-labelledby="about-title">
        <header className="about-header">
          <div className="about-brand">
            <div className="about-mark" aria-hidden="true"><GitBranch size={22} /></div>
            <div>
              <h2 id="about-title">Git History Viewer</h2>
              <p>关于</p>
            </div>
          </div>
          <button className="icon-button" type="button" aria-label="关闭" title="关闭" onClick={() => setAboutOpen(false)}><X size={18} /></button>
        </header>
        <dl className="about-details">
          <div><dt>版本</dt><dd><code>{applicationVersion}</code></dd></div>
          <div><dt>作者</dt><dd>sunjx</dd></div>
        </dl>
        <div className="about-actions"><button className="secondary-button" type="button" onClick={() => setAboutOpen(false)}>关闭</button></div>
      </section>
    </div>
  ) : null
  const gettingStartedDialog = gettingStartedMode ? (
    <div className="modal-backdrop" role="presentation">
      <section className="modal getting-started-modal" role="dialog" aria-modal="true" aria-labelledby="getting-started-title">
        <div className="modal-heading">
          <div>
            <h2 id="getting-started-title">使用说明</h2>
            <p>完成以下准备后，即可开始查看 Git 提交历史。</p>
          </div>
          <button className="icon-button" type="button" aria-label="关闭" title="关闭" onClick={closeGettingStarted}><X size={18} /></button>
        </div>
        <ol className="getting-started-steps">
          <li>
            <div>
              <strong>本地仓库安装 Git for Windows</strong>
              <a href={gitForWindowsInstallUrl} className="instruction-link" onClick={(event) => { event.preventDefault(); void window.gitHistory.openGitForWindowsDownload() }}>
                <span>{gitForWindowsInstallUrl}</span><ExternalLink size={14} aria-hidden="true" />
              </a>
            </div>
          </li>
          <li>
            <div><strong>配置代码比较工具</strong><button className="quiet-button getting-started-action" type="button" onClick={() => { closeGettingStarted(); void openSettings() }}><Settings size={15} />配置外部对比工具</button></div>
          </li>
          <li><div><strong>打开 Git 仓库</strong><span>本地仓库使用本机 Git；映射盘先配置 SSH 映射，右键后由服务器执行 Git。</span><button className="quiet-button getting-started-action" type="button" onClick={() => { closeGettingStarted(); void openSshMappings() }}><Network size={15} />配置 SSH 映射</button></div></li>
        </ol>
        <div className={`getting-started-footer ${gettingStartedMode === 'startup' ? 'has-dismissal' : ''}`}>
          {gettingStartedMode === 'startup' && (
            <label className="check-row"><input type="checkbox" checked={dismissGettingStarted} onChange={(event) => updateGettingStartedDismissal(event.target.checked)} />后续不再提醒</label>
          )}
          <button className="primary-button" type="button" onClick={closeGettingStarted}>开始使用</button>
        </div>
      </section>
    </div>
  ) : null

  if (!repository) {
    return (
      <main className="welcome-shell">
        <header className="welcome-top-bar">
          <nav className="welcome-menu" aria-label="应用菜单">
            <div className="menu-dropdown" ref={helpMenuRef}>
              <button className="menu-trigger" type="button" aria-haspopup="menu" aria-expanded={helpMenuOpen} onClick={() => setHelpMenuOpen((open) => !open)}>帮助<ChevronDown size={14} aria-hidden="true" /></button>
              {helpMenuOpen && (
                <div className="menu-popover" role="menu" aria-label="帮助菜单">
                  <button className="menu-item" type="button" role="menuitem" onClick={() => { setHelpMenuOpen(false); setGettingStartedMode('help') }}><BookOpen size={16} aria-hidden="true" /><span>使用说明</span></button>
                  <div className="menu-separator" role="separator" />
                  <button className="menu-item" type="button" role="menuitem" onClick={() => { setHelpMenuOpen(false); setAboutOpen(true) }}><Info size={16} aria-hidden="true" /><span>关于</span></button>
                </div>
              )}
            </div>
          </nav>
          <div className="welcome-corner-actions">
            <button className="secondary-button compact" type="button" onClick={() => void openUserDataDirectory()}>
              <FolderOpen size={15} />打开数据目录
            </button>
            <button className="secondary-button compact" type="button" onClick={() => void openSshMappings()}>
              <Network size={15} />SSH 映射
            </button>
            <button className="secondary-button compact" type="button" onClick={() => void openSettings()}>
              <Settings size={15} />外部对比工具
            </button>
            <button className="icon-button" type="button" title="切换主题" aria-label="切换主题" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>
              {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
            </button>
          </div>
        </header>
        <section className="welcome-content" aria-labelledby="welcome-title">
          <div className="welcome-mark"><GitBranch size={32} /></div>
          <h1 id="welcome-title">打开一个仓库</h1>
          <p>查看提交历史、提交说明和与上一版的文件对比。</p>
          <div className="welcome-actions">
            <button className="primary-button" type="button" onClick={() => void openLocalRepository()}>
              <FolderOpen size={18} />打开本地仓库
            </button>
            <button className="secondary-button" type="button" onClick={() => setRemoteOpen(true)}>
              <Download size={18} />导入远程仓库
            </button>
          </div>
          {recentRepositories.length > 0 && (
            <section className="recent-repositories" aria-labelledby="recent-repositories-title">
              <div className="recent-repositories-heading">
                <h2 id="recent-repositories-title">最近打开</h2>
                <button className="quiet-button compact" type="button" onClick={() => setClearRecentConfirmOpen(true)}>
                  <Trash2 size={15} />清空
                </button>
              </div>
              <div className="recent-repositories-list" role="list">
                {recentRepositories.map((recent) => (
                  <div className="recent-repository-row" role="listitem" key={recent.path}>
                    <button
                      className="recent-repository-open"
                      type="button"
                      onClick={() => void openRecentRepository(recent)}
                      title={`打开 ${repositoryDisplayPath(recent)}`}
                    >
                      <FolderGit2 size={18} aria-hidden="true" />
                      <span className="recent-repository-info">
                        <strong>{recent.name}</strong>
                        <span title={repositoryDisplayPath(recent)}>{repositoryDisplayPath(recent)}</span>
                      </span>
                      <time dateTime={recent.lastOpenedAt}>{formatDate(recent.lastOpenedAt)}</time>
                    </button>
                    <button
                      className="icon-button compact-icon-button"
                      type="button"
                      aria-label={`从最近打开列表移除 ${recent.name}`}
                      title="从列表移除"
                      onClick={() => void removeRecentRepository(recent.path)}
                    >
                      <X size={16} />
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}
          {error && <div className="inline-error" role="alert">{error}</div>}
        </section>
        {remoteOpen && (
          <div className="modal-backdrop" role="presentation">
            <section className="modal" role="dialog" aria-modal="true" aria-labelledby="remote-title">
              <div className="modal-heading"><div><h2 id="remote-title">导入远程仓库</h2><p>仓库将以只读方式克隆到选定位置。</p></div><button className="icon-button" type="button" title="关闭" aria-label="关闭" onClick={() => setRemoteOpen(false)}><X size={18} /></button></div>
              <label>仓库地址<input value={remoteUrl} onChange={(event) => setRemoteUrl(event.target.value)} placeholder="https://github.com/owner/repository.git" autoFocus /></label>
              <label>保存位置<div className="path-picker"><input value={cloneDestination} onChange={(event) => setCloneDestination(event.target.value)} placeholder="选择一个新的目标目录" /><button className="secondary-button compact" type="button" onClick={() => void chooseCloneDestination()}>浏览</button></div></label>
              {error && <div className="inline-error" role="alert">{error}</div>}
              <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setRemoteOpen(false)}>取消</button><button className="primary-button" type="button" onClick={() => void importRemoteRepository()} disabled={Boolean(busyMessage)}>{busyMessage ? <LoaderCircle className="spin" size={17} /> : <Download size={17} />}{busyMessage || '开始导入'}</button></div>
            </section>
          </div>
        )}
        {clearRecentConfirmOpen && (
          <div className="modal-backdrop" role="presentation">
            <section className="modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="clear-recent-title">
              <div className="modal-heading">
                <div>
                  <h2 id="clear-recent-title">清空最近项目</h2>
                  <p>这只会移除最近打开记录，不会删除本地仓库或其中的文件。</p>
                </div>
                <button className="icon-button" type="button" title="关闭" aria-label="关闭" disabled={clearingRecentRepositories} onClick={() => setClearRecentConfirmOpen(false)}><X size={18} /></button>
              </div>
              <div className="modal-actions">
                <button className="secondary-button" type="button" disabled={clearingRecentRepositories} onClick={() => setClearRecentConfirmOpen(false)}>取消</button>
                <button className="danger-button" type="button" disabled={clearingRecentRepositories} onClick={() => void clearRecentRepositories()}>
                  {clearingRecentRepositories ? <LoaderCircle className="spin" size={17} /> : <Trash2 size={17} />}清空记录
                </button>
              </div>
            </section>
          </div>
        )}
        {settingsDialog}
        {sshMappingsDialog}
        {aboutDialog}
        {gettingStartedDialog}
      </main>
    )
  }

  return (
    <main ref={appShellRef} className="app-shell" style={appShellStyle}>
      <header className="app-toolbar">
        <div className="brand repo-brand"><FolderGit2 size={19} /><div><strong>{repository.name}</strong><span title={repositoryDisplayPath(repository)}>{repositoryDisplayPath(repository)}</span></div></div>
        <div className="toolbar-center"><span className="branch-chip"><GitBranch size={15} />{repository.branch}</span>{repository.head && <code className="head-chip">{repository.head}</code>}</div>
        <div className="toolbar-actions">
          <button className="secondary-button compact" type="button" onClick={closeRepository}><X size={15} />关闭项目</button>
          <button className="secondary-button compact" type="button" onClick={() => void openSshMappings()}><Network size={15} />SSH 映射</button>
          <button className="secondary-button compact" type="button" onClick={() => void openSettings()}><Settings size={15} />外部对比工具</button>
          <button className="icon-button" type="button" title="重新加载提交历史" aria-label="重新加载提交历史" onClick={() => void loadHistory()}><Clock3 size={18} /></button>
          <button className="icon-button" type="button" title="切换主题" aria-label="切换主题" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}</button>
        </div>
      </header>

      <section className="filter-bar" aria-label="提交筛选">
        <div className="filter-search">
          <Search size={17} aria-hidden="true" />
          <input value={filter.query} onChange={(event) => setFilter({ ...filter, query: event.target.value })} placeholder="筛选提交信息、路径、作者、Hash" aria-label="搜索提交" />
        </div>
        <select value={filter.scope} onChange={(event) => setFilter({ ...filter, scope: event.target.value as SearchScope })} aria-label="筛选字段">
          {searchScopes.map((scope) => <option key={scope.value} value={scope.value}>{scope.label}</option>)}
        </select>
        <span className="date-filter"><CalendarDays size={15} /><label>From<input type="date" value={filter.from} onChange={(event) => setFilter({ ...filter, from: event.target.value })} /></label><label>To<input type="date" value={filter.to} onChange={(event) => setFilter({ ...filter, to: event.target.value })} /></label></span>
        {activeFilterCount > 0 && <button className="quiet-button" type="button" onClick={clearFilter}><X size={15} />清除</button>}
        <span className="result-summary">{loadingHistory ? <LoaderCircle className="spin" size={15} /> : null}显示 {commits.length.toLocaleString()} 条</span>
        {historyHasMore && (
          <button className="quiet-button compact" type="button" onClick={() => void loadHistory(true)} disabled={loadingHistory}>
            继续加载
          </button>
        )}
      </section>

      {error && <div className="toast-error" role="alert"><span>{error}</span><button className="icon-button" type="button" aria-label="关闭错误提示" title="关闭" onClick={() => setError('')}><X size={16} /></button></div>}

      <HistoryTable
        commits={commits}
        selectedHash={selectedHash}
        onSelect={setSelectedHash}
      />

      <section className="bottom-panel" aria-label="变更路径">
        <div
          className="panel-resizer"
          role="separator"
          aria-orientation="horizontal"
          aria-label="调整变更路径区域高度"
          tabIndex={0}
          onPointerDown={startPathsResize}
          onPointerMove={resizePaths}
          onPointerUp={finishPathsResize}
          onPointerCancel={finishPathsResize}
          onLostPointerCapture={finishPathsResize}
          onKeyDown={resizePathsWithKeyboard}
        />
        {loadingDetails ? (
          <div className="detail-loading"><LoaderCircle className="spin" size={20} />正在读取记录信息...</div>
        ) : !details ? (
          <div className="detail-loading">选择一条提交以查看变更路径。</div>
        ) : (
          <aside className="paths-panel">
            <div className="panel-title">
              <span>Changed Paths</span>
            </div>
            {visibleFileCount > 0 && (
              <div className="file-table-header" aria-hidden="true">
                <span>Path</span>
                <span>Action</span>
                <span />
              </div>
            )}
            <FileList
              pages={filePages}
              total={visibleFileCount}
              loading={fileChangesLoading}
              selectedFile={selectedFile}
              onSelect={setSelectedFile}
              onCompare={(file) => void openExternalComparison(file)}
              onRequestPage={requestFileChangesPage}
            />
          </aside>
        )}
      </section>

      {settingsDialog}
      {sshMappingsDialog}

      {busyMessage && <div className="busy-overlay"><LoaderCircle className="spin" size={24} />{busyMessage}</div>}
    </main>
  )
}

export default App
