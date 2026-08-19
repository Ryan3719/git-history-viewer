import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BookOpen,
  CalendarDays,
  ChevronDown,
  Download,
  FolderGit2,
  FolderOpen,
  GitBranch,
  Info,
  LoaderCircle,
  Moon,
  Network,
  RefreshCw,
  Search,
  Settings,
  Sun,
  Trash2,
  X
} from 'lucide-react'
import { FileList, HistoryTable } from './components/HistoryViews'
import {
  AboutDialog,
  GettingStartedDialog,
  SettingsDialog,
  SshMappingsDialog,
  type GettingStartedMode
} from './components/AppDialogs'
import {
  fileChangesPageSize,
  initialHistoryFilter,
  useRepositoryHistory
} from './hooks/useRepositoryHistory'
import { useSshMappings } from './hooks/useSshMappings'
import type {
  ExternalDiffSettings,
  FileChange,
  HistoryFilter,
  RecentRepository,
  RepositoryInfo,
  RepositoryOpenRequest,
  SearchScope,
} from '../../shared/types'

type Theme = 'light' | 'dark'

type PathsResizeState = {
  pointerId: number
  startY: number
  startHeight: number
  maximumHeight: number
}

const minimumPathsPanelHeight = 160
const minimumHistoryHeight = 230
const applicationChromeHeight = 104

const searchScopes: Array<{ value: SearchScope; label: string }> = [
  { value: 'all', label: '全部字段' },
  { value: 'message', label: '提交信息' },
  { value: 'author', label: '作者' },
  { value: 'path', label: '文件路径' },
  { value: 'hash', label: 'Hash' }
]

function repositoryDisplayPath(repository: RepositoryInfo): string {
  const rootPath = repository.displayPath ?? repository.path
  if (!repository.pathScope) return rootPath
  const separator = rootPath.includes('\\') ? '\\' : '/'
  return `${rootPath.replace(/[\\/]+$/, '')}${separator}${repository.pathScope}`
}

function repositoryReferenceKey(repository: RepositoryOpenRequest): string {
  return `${repository.path}\u0000${repository.pathScope ?? ''}`
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

function App(): React.JSX.Element {
  const appShellRef = useRef<HTMLElement>(null)
  const helpMenuRef = useRef<HTMLDivElement>(null)
  const pathsResizeRef = useRef<PathsResizeState | null>(null)
  const repositoryOpenRequestRef = useRef(0)
  const [repository, setRepository] = useState<RepositoryInfo | null>(null)
  const [recentRepositories, setRecentRepositories] = useState<RecentRepository[]>([])
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('theme') as Theme) || 'light')
  const [openingRepository, setOpeningRepository] = useState(false)
  const [busyMessage, setBusyMessage] = useState('')
  const [error, setError] = useState('')
  const [remoteOpen, setRemoteOpen] = useState(false)
  const [clearRecentConfirmOpen, setClearRecentConfirmOpen] = useState(false)
  const [clearingRecentRepositories, setClearingRecentRepositories] = useState(false)
  const [remoteUrl, setRemoteUrl] = useState('')
  const [cloneDestination, setCloneDestination] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [helpMenuOpen, setHelpMenuOpen] = useState(false)
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
  const {
    filter,
    setFilter,
    commits,
    selectedHash,
    setSelectedHash,
    details,
    fileChangesStatus,
    filePages,
    selectedFile,
    setSelectedFile,
    loadingHistory,
    historyHasMore,
    loadingDetails,
    loadHistory,
    requestFileChangesPage,
    reset: resetRepositoryHistory
  } = useRepositoryHistory(repository, setError)
  const sshMappings = useSshMappings(setError)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('theme', theme)
  }, [theme])

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

  const selectRepository = useCallback((repo: RepositoryInfo): void => {
    resetRepositoryHistory()
    setRepository(repo)
    void window.gitHistory.addRecentRepository(repo).then(setRecentRepositories).catch((saveError) => {
      setError(saveError instanceof Error ? saveError.message : '无法保存最近打开的项目。')
    })
  }, [resetRepositoryHistory])

  const closeRepository = (): void => {
    resetRepositoryHistory()
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
    setOpeningRepository(true)
    try {
      const repo = await window.gitHistory.pickLocalRepository()
      if (repo) {
        selectRepository(repo)
      }
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : '所选目录不是可读取的 Git 仓库。')
    } finally {
      setOpeningRepository(false)
    }
  }

  const openRepositoryPath = useCallback(async (
    repositoryReference: RepositoryOpenRequest,
    failureMessage: string
  ): Promise<void> => {
    const requestId = ++repositoryOpenRequestRef.current
    setError('')
    setOpeningRepository(true)
    try {
      const repo = await window.gitHistory.openRecentRepository(repositoryReference)
      if (requestId === repositoryOpenRequestRef.current) selectRepository(repo)
    } catch (openError) {
      if (requestId === repositoryOpenRequestRef.current) {
        setError(openError instanceof Error ? openError.message : failureMessage)
      }
    } finally {
      if (requestId === repositoryOpenRequestRef.current) setOpeningRepository(false)
    }
  }, [selectRepository])

  const openRecentRepository = async (recent: RecentRepository): Promise<void> => {
    await openRepositoryPath(recent, '无法打开该项目。请确认仓库路径仍然可用。')
  }

  useEffect(() => {
    const removeListener = window.gitHistory.onRepositoryRequested((repository) => {
      void openRepositoryPath(repository, '所选路径不在可读取的 Git 仓库中。')
    })
    void window.gitHistory.notifyRepositoryListenerReady()
    return removeListener
  }, [openRepositoryPath])

  const removeRecentRepository = async (repository: RepositoryOpenRequest): Promise<void> => {
    try {
      setRecentRepositories(await window.gitHistory.removeRecentRepository(repository))
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

  const clearFilter = (): void => setFilter(initialHistoryFilter)

  const openSettings = async (): Promise<void> => {
    setExternalSettings(await window.gitHistory.getExternalDiffSettings())
    setSettingsNotice('')
    setSettingsOpen(true)
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
  const settingsDialog = (
    <SettingsDialog
      open={settingsOpen}
      settings={externalSettings}
      notice={settingsNotice}
      onSettingsChange={(settings) => setExternalSettings({
        ...settings,
        argumentsTemplate: externalDiffArgumentsTemplate(settings.command)
      })}
      onBrowse={() => void chooseExternalDiffTool()}
      onSave={() => void saveSettings()}
      onClose={() => setSettingsOpen(false)}
    />
  )
  const sshMappingsDialog = (
    <SshMappingsDialog
      open={sshMappings.open}
      mappings={sshMappings.mappings}
      draft={sshMappings.draft}
      password={sshMappings.password}
      showPassword={sshMappings.showPassword}
      notice={sshMappings.notice}
      testing={sshMappings.testing}
      saving={sshMappings.saving}
      onDraftChange={sshMappings.setDraft}
      onPasswordChange={sshMappings.setPassword}
      onTogglePassword={sshMappings.togglePassword}
      onEdit={sshMappings.edit}
      onAdd={sshMappings.add}
      onRemove={(mapping) => void sshMappings.remove(mapping)}
      onTest={() => void sshMappings.test()}
      onSave={() => void sshMappings.save()}
      onClose={sshMappings.closeDialog}
    />
  )
  const aboutDialog = <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
  const gettingStartedDialog = (
    <GettingStartedDialog
      mode={gettingStartedMode}
      dismissed={dismissGettingStarted}
      onDismissedChange={updateGettingStartedDismissal}
      onClose={closeGettingStarted}
      onOpenLocal={() => { closeGettingStarted(); void openLocalRepository() }}
      onOpenRemote={() => { closeGettingStarted(); setRemoteOpen(true) }}
      onOpenSsh={() => { closeGettingStarted(); void sshMappings.openDialog() }}
      onOpenSettings={() => { closeGettingStarted(); void openSettings() }}
    />
  )

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
            <button className="secondary-button compact" type="button" onClick={() => void sshMappings.openDialog()}>
              <Network size={15} />SSH 服务器
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
                  <div className="recent-repository-row" role="listitem" key={repositoryReferenceKey(recent)}>
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
                      onClick={() => void removeRecentRepository(recent)}
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
        {openingRepository && <div className="busy-overlay" role="status" aria-live="polite"><LoaderCircle className="spin" size={24} />正在读取仓库...</div>}
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
          <button className="icon-button" type="button" title="刷新提交历史" aria-label="刷新提交历史" disabled={loadingHistory} onClick={() => void loadHistory()}><RefreshCw className={loadingHistory ? 'spin' : undefined} size={18} /></button>
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
        formatDate={formatDate}
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
              pageSize={fileChangesPageSize}
              onSelect={setSelectedFile}
              onCompare={(file) => void openExternalComparison(file)}
              onRequestPage={requestFileChangesPage}
            />
          </aside>
        )}
      </section>

      {settingsDialog}
      {sshMappingsDialog}

      {openingRepository && <div className="busy-overlay" role="status" aria-live="polite"><LoaderCircle className="spin" size={24} />正在读取仓库...</div>}
      {busyMessage && <div className="busy-overlay" role="status" aria-live="polite"><LoaderCircle className="spin" size={24} />{busyMessage}</div>}
    </main>
  )
}

export default App
