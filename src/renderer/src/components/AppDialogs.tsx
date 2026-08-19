import {
  Check,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FolderOpen,
  GitBranch,
  LoaderCircle,
  Network,
  Plus,
  Server,
  Settings,
  Trash2,
  X
} from 'lucide-react'
import type { ExternalDiffSettings, SshRepositoryMapping } from '../../../shared/types'

export type GettingStartedMode = 'startup' | 'help' | null
export type Notice = { tone: 'error' | 'success'; message: string }

const gitForWindowsInstallUrl = 'https://git-scm.com/install/windows'

export function SettingsDialog({
  open,
  settings,
  notice,
  onSettingsChange,
  onBrowse,
  onSave,
  onClose
}: {
  open: boolean
  settings: ExternalDiffSettings
  notice: string
  onSettingsChange: (settings: ExternalDiffSettings) => void
  onBrowse: () => void
  onSave: () => void
  onClose: () => void
}): React.JSX.Element | null {
  if (!open) return null
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="modal-heading"><div><h2 id="settings-title">外部对比工具</h2></div><button className="icon-button" type="button" aria-label="关闭" title="关闭" onClick={onClose}><X size={18} /></button></div>
        <label>程序路径<div className="path-picker"><input value={settings.command} onChange={(event) => onSettingsChange({ ...settings, command: event.target.value })} placeholder="C:\Program Files\WinMerge\WinMergeU.exe" autoFocus /><button className="secondary-button compact" type="button" onClick={onBrowse}>浏览</button></div></label>
        {notice && <div className="inline-error" role="alert">{notice}</div>}
        <div className="modal-actions"><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="button" onClick={onSave}><Check size={17} />保存</button></div>
      </section>
    </div>
  )
}

function mappingLabel(mapping: SshRepositoryMapping): string {
  return `${mapping.username}@${mapping.host}`
}

export function SshMappingsDialog({
  open,
  mappings,
  draft,
  password,
  showPassword,
  notice,
  testing,
  saving,
  onDraftChange,
  onPasswordChange,
  onTogglePassword,
  onEdit,
  onAdd,
  onRemove,
  onTest,
  onSave,
  onClose
}: {
  open: boolean
  mappings: SshRepositoryMapping[]
  draft: SshRepositoryMapping | null
  password: string
  showPassword: boolean
  notice: Notice | null
  testing: boolean
  saving: boolean
  onDraftChange: (draft: SshRepositoryMapping) => void
  onPasswordChange: (password: string) => void
  onTogglePassword: () => void
  onEdit: (mapping: SshRepositoryMapping) => void
  onAdd: () => void
  onRemove: (mapping: SshRepositoryMapping) => void
  onTest: () => void
  onSave: () => void
  onClose: () => void
}): React.JSX.Element | null {
  if (!open) return null
  const busy = testing || saving
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal ssh-mappings-modal" role="dialog" aria-modal="true" aria-labelledby="ssh-mappings-title">
        <div className="modal-heading">
          <div><h2 id="ssh-mappings-title">SSH 服务器</h2><p>管理网络盘仓库使用的服务器账号。</p></div>
          <button className="icon-button" type="button" aria-label="关闭" title="关闭" disabled={busy} onClick={onClose}><X size={18} /></button>
        </div>
        {draft ? (
          <form className="ssh-mapping-form" onSubmit={(event) => { event.preventDefault(); onSave() }}>
            <div className="ssh-mapping-grid">
              <div className="ssh-server-address-row wide">
                <label><span>服务器地址 <b aria-hidden="true">*</b></span><input value={draft.host} onChange={(event) => onDraftChange({ ...draft, host: event.target.value })} placeholder="192.168.160.76" autoComplete="off" required autoFocus /></label>
                <label><span>端口 <b aria-hidden="true">*</b></span><input type="number" min="1" max="65535" value={draft.port} onChange={(event) => onDraftChange({ ...draft, port: Number(event.target.value) })} required /></label>
              </div>
              <label className="wide"><span>用户名 <b aria-hidden="true">*</b></span><input value={draft.username} onChange={(event) => onDraftChange({ ...draft, username: event.target.value })} placeholder="用户名" autoComplete="username" required /></label>
              <label className="wide"><span>密码 <b aria-hidden="true">*</b></span><div className="password-input"><input type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => onPasswordChange(event.target.value)} placeholder={draft.hasStoredPassword ? '留空则保持现有密码' : '输入 SSH 密码'} autoComplete="current-password" required={!draft.hasStoredPassword} /><button className="icon-button password-visibility-button" type="button" aria-label={showPassword ? '隐藏 SSH 密码' : '显示 SSH 密码'} title={showPassword ? '隐藏密码' : '显示密码'} onClick={onTogglePassword}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label>
            </div>
            {notice && <div className={`ssh-mapping-notice ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.message}</div>}
            <div className="modal-actions">
              <button className="secondary-button" type="button" disabled={busy} onClick={onTest}>{testing ? <LoaderCircle className="spin" size={17} /> : <Network size={17} />}测试连接</button>
              <button className="primary-button" type="submit" disabled={busy}>{saving ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}{saving ? '正在保存' : '保存服务器'}</button>
            </div>
          </form>
        ) : (
          <>
            <div className="ssh-mapping-list" role="list" aria-label="SSH 服务器列表">
              {mappings.length === 0 ? (
                <div className="ssh-mapping-empty"><Server size={20} aria-hidden="true" /><span>尚未添加 SSH 服务器</span></div>
              ) : mappings.map((mapping) => (
                <div className="ssh-mapping-row" role="listitem" key={mapping.id}>
                  <div className="ssh-mapping-summary"><strong>{mappingLabel(mapping)}</strong><span title={`${mapping.host}:${mapping.port}`}>{mapping.host}:{mapping.port}</span><small className={mapping.hasStoredPassword ? '' : 'needs-password'}>{mapping.hasStoredPassword ? '密码已安全保存' : '需要设置密码'}</small></div>
                  <div className="ssh-mapping-row-actions"><button className="secondary-button compact" type="button" onClick={() => onEdit(mapping)}>编辑</button><button className="icon-button" type="button" aria-label={`移除 SSH 服务器 ${mappingLabel(mapping)}`} title="移除服务器" onClick={() => onRemove(mapping)}><Trash2 size={17} /></button></div>
                </div>
              ))}
            </div>
            {notice && <div className={`ssh-mapping-notice ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.message}</div>}
            <div className="modal-actions"><button className="secondary-button" type="button" onClick={onClose}>关闭</button><button className="primary-button" type="button" onClick={onAdd}><Plus size={17} />添加服务器</button></div>
          </>
        )}
      </section>
    </div>
  )
}

export function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element | null {
  if (!open) return null
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal about-modal" role="dialog" aria-modal="true" aria-labelledby="about-title">
        <header className="about-header">
          <div className="about-brand"><div className="about-mark" aria-hidden="true"><GitBranch size={22} /></div><div><h2 id="about-title">Git History Viewer</h2><p>关于</p></div></div>
          <button className="icon-button" type="button" aria-label="关闭" title="关闭" onClick={onClose}><X size={18} /></button>
        </header>
        <dl className="about-details"><div><dt>版本</dt><dd><code>{__APP_VERSION__}</code></dd></div><div><dt>作者</dt><dd>sunjx</dd></div></dl>
        <div className="about-actions"><button className="secondary-button" type="button" onClick={onClose}>关闭</button></div>
      </section>
    </div>
  )
}

export function GettingStartedDialog({
  mode,
  dismissed,
  onDismissedChange,
  onClose,
  onOpenLocal,
  onOpenRemote,
  onOpenSsh,
  onOpenSettings
}: {
  mode: GettingStartedMode
  dismissed: boolean
  onDismissedChange: (dismissed: boolean) => void
  onClose: () => void
  onOpenLocal: () => void
  onOpenRemote: () => void
  onOpenSsh: () => void
  onOpenSettings: () => void
}): React.JSX.Element | null {
  if (!mode) return null
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal getting-started-modal" role="dialog" aria-modal="true" aria-labelledby="getting-started-title">
        <div className="modal-heading"><div><h2 id="getting-started-title">{mode === 'startup' ? '欢迎使用' : '功能说明'}</h2>{mode === 'startup' && <p>三步开始查看本地、远程或网络盘仓库历史。</p>}</div><button className="icon-button" type="button" aria-label="关闭" title="关闭" onClick={onClose}><X size={18} /></button></div>
        {mode === 'startup' ? (
          <ol className="getting-started-steps">
            <li><div><strong>准备 Git 环境</strong><span>打开本地仓库和导入远程仓库需要 Git for Windows。</span><a href={gitForWindowsInstallUrl} className="instruction-link" onClick={(event) => { event.preventDefault(); void window.gitHistory.openGitForWindowsDownload() }}><span>{gitForWindowsInstallUrl}</span><ExternalLink size={14} aria-hidden="true" /></a></div></li>
            <li><div><strong>选择仓库入口</strong><span>打开本地目录、导入远程仓库，或在资源管理器中右键目录、目录空白处或文件。</span><div className="getting-started-actions"><button className="quiet-button getting-started-action" type="button" onClick={onOpenLocal}><FolderOpen size={15} />打开本地仓库</button><button className="quiet-button getting-started-action" type="button" onClick={onOpenRemote}><Download size={15} />导入远程仓库</button></div></div></li>
            <li><div><strong>按需配置工具</strong><span>网络盘仓库使用 SSH 密码服务器；双击变更文件前需配置外部对比工具。</span><div className="getting-started-actions"><button className="quiet-button getting-started-action" type="button" onClick={onOpenSsh}><Network size={15} />SSH 服务器</button><button className="quiet-button getting-started-action" type="button" onClick={onOpenSettings}><Settings size={15} />外部对比工具</button></div></div></li>
          </ol>
        ) : (
          <ol className="getting-started-steps">
            <li><div><strong>打开仓库</strong><span>支持本地目录、最近打开和远程仓库导入。可在资源管理器中右键目录、目录空白处或单个文件，直接查看对应范围的历史。</span></div></li>
            <li><div><strong>访问网络盘仓库</strong><span>添加与网络盘主机对应的 SSH 服务器，填写地址、端口、用户名和密码。密码由当前 Windows 帐户加密保存，Git 命令在服务器执行。</span><button className="quiet-button getting-started-action" type="button" onClick={onOpenSsh}><Network size={15} />管理 SSH 服务器</button></div></li>
            <li><div><strong>对比文件</strong><span>配置外部对比工具后，双击变更路径即可查看提交前后的文件差异。</span><button className="quiet-button getting-started-action" type="button" onClick={onOpenSettings}><Settings size={15} />配置外部对比工具</button></div></li>
          </ol>
        )}
        <div className={`getting-started-footer ${mode === 'startup' ? 'has-dismissal' : ''}`}>{mode === 'startup' && <label className="check-row"><input type="checkbox" checked={dismissed} onChange={(event) => onDismissedChange(event.target.checked)} />启动时不再显示</label>}<button className="primary-button" type="button" autoFocus onClick={onClose}>{mode === 'startup' ? '开始使用' : '关闭'}</button></div>
      </section>
    </div>
  )
}
