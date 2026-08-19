import { useState } from 'react'
import type { SshRepositoryMapping } from '../../../shared/types'
import type { Notice } from '../components/AppDialogs'

function emptyMapping(): SshRepositoryMapping {
  return {
    id: crypto.randomUUID(),
    host: '',
    port: 22,
    username: ''
  }
}

function mappingLabel(mapping: SshRepositoryMapping): string {
  return `${mapping.username}@${mapping.host}`
}

export function useSshMappings(onError: (message: string) => void): {
  open: boolean
  mappings: SshRepositoryMapping[]
  draft: SshRepositoryMapping | null
  password: string
  showPassword: boolean
  notice: Notice | null
  testing: boolean
  saving: boolean
  setDraft: React.Dispatch<React.SetStateAction<SshRepositoryMapping | null>>
  setPassword: React.Dispatch<React.SetStateAction<string>>
  togglePassword: () => void
  openDialog: () => Promise<void>
  closeDialog: () => void
  edit: (mapping: SshRepositoryMapping) => void
  add: () => void
  remove: (mapping: SshRepositoryMapping) => Promise<void>
  test: () => Promise<void>
  save: () => Promise<void>
} {
  const [open, setOpen] = useState(false)
  const [mappings, setMappings] = useState<SshRepositoryMapping[]>([])
  const [draft, setDraft] = useState<SshRepositoryMapping | null>(null)
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)

  const resetEditor = (): void => {
    setDraft(null)
    setPassword('')
    setShowPassword(false)
    setNotice(null)
  }

  const openDialog = async (): Promise<void> => {
    try {
      setMappings(await window.gitHistory.listSshRepositoryMappings())
      resetEditor()
      setSaving(false)
      setOpen(true)
    } catch (error) {
      onError(error instanceof Error ? error.message : '无法读取 SSH 服务器配置。')
    }
  }

  const edit = (mapping: SshRepositoryMapping): void => {
    setDraft({ ...mapping })
    setPassword('')
    setShowPassword(false)
    setNotice(null)
  }

  const add = (): void => {
    setDraft(emptyMapping())
    setPassword('')
    setShowPassword(false)
    setNotice(null)
  }

  const validate = (): SshRepositoryMapping | null => {
    if (!draft) return null
    const mapping: SshRepositoryMapping = {
      id: draft.id || crypto.randomUUID(),
      host: draft.host.trim(),
      port: Math.floor(Number(draft.port)),
      username: draft.username.trim(),
      hasStoredPassword: draft.hasStoredPassword
    }
    if (!mapping.host || !mapping.username) {
      setNotice({ tone: 'error', message: '请填写服务器主机和 SSH 用户名。' })
      return null
    }
    if (!Number.isInteger(mapping.port) || mapping.port < 1 || mapping.port > 65535) {
      setNotice({ tone: 'error', message: 'SSH 端口必须在 1 到 65535 之间。' })
      return null
    }
    const existing = mappings.find((item) => item.id === mapping.id)
    if (!password && !existing?.hasStoredPassword) {
      setNotice({ tone: 'error', message: '请输入 SSH 密码。密码会使用 Windows 凭据加密保存。' })
      return null
    }
    const normalizedHost = mapping.host.replace(/^\[|\]$/g, '').toLocaleLowerCase()
    const duplicate = mappings.some((item) => item.id !== mapping.id &&
      item.host.replace(/^\[|\]$/g, '').toLocaleLowerCase() === normalizedHost)
    if (duplicate) {
      setNotice({ tone: 'error', message: '该服务器地址已经配置。请编辑已有服务器。' })
      return null
    }
    return mapping
  }

  const save = async (): Promise<void> => {
    const mapping = validate()
    if (!mapping) return
    setSaving(true)
    setNotice(null)
    try {
      const next = mappings.some((item) => item.id === mapping.id)
        ? mappings.map((item) => (item.id === mapping.id ? mapping : item))
        : [...mappings, mapping]
      await window.gitHistory.saveSshRepositoryMappings(next)
      if (password) {
        await window.gitHistory.setSshRepositoryPassword(mapping.id, password)
      }
      setMappings(await window.gitHistory.listSshRepositoryMappings())
      setDraft(null)
      setPassword('')
      setShowPassword(false)
      setNotice({ tone: 'success', message: 'SSH 服务器已保存。' })
    } catch (error) {
      try {
        setMappings(await window.gitHistory.listSshRepositoryMappings())
      } catch {
        // Preserve the original operation error.
      }
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : '无法保存 SSH 服务器。' })
    } finally {
      setSaving(false)
    }
  }

  const test = async (): Promise<void> => {
    const mapping = validate()
    if (!mapping) return
    setTesting(true)
    setNotice(null)
    try {
      await window.gitHistory.testSshRepositoryMapping(mapping, password || undefined)
      setNotice({ tone: 'success', message: 'SSH 连接成功，服务器可以执行 Git。' })
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'SSH 连接测试失败。' })
    } finally {
      setTesting(false)
    }
  }

  const remove = async (mapping: SshRepositoryMapping): Promise<void> => {
    if (!window.confirm(`移除 SSH 服务器 ${mappingLabel(mapping)}？`)) return
    try {
      const next = await window.gitHistory.saveSshRepositoryMappings(
        mappings.filter((item) => item.id !== mapping.id)
      )
      setMappings(next)
      setNotice({ tone: 'success', message: 'SSH 服务器已移除。' })
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : '无法移除 SSH 服务器。' })
    }
  }

  return {
    open,
    mappings,
    draft,
    password,
    showPassword,
    notice,
    testing,
    saving,
    setDraft,
    setPassword,
    togglePassword: () => setShowPassword((visible) => !visible),
    openDialog,
    closeDialog: () => setOpen(false),
    edit,
    add,
    remove,
    test,
    save
  }
}
