import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CommitDetails,
  CommitSummary,
  FileChange,
  FileChangesStatus,
  HistoryFilter,
  HistoryPage,
  RepositoryInfo
} from '../../../shared/types'

export const historyPageSize = 100
export const fileChangesPageSize = 200
const maxCachedFileChangePages = 5

export const initialHistoryFilter: HistoryFilter = {
  query: '',
  scope: 'all',
  from: '',
  to: '',
  limit: historyPageSize
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === 'AbortError' ||
    error.message.includes('AbortError') ||
    error.message.includes('Git 读取已取消')
  )
}

export function useRepositoryHistory(
  repository: RepositoryInfo | null,
  onError: (message: string) => void
): {
  filter: HistoryFilter
  setFilter: React.Dispatch<React.SetStateAction<HistoryFilter>>
  commits: CommitSummary[]
  selectedHash: string | null
  setSelectedHash: React.Dispatch<React.SetStateAction<string | null>>
  details: CommitDetails | null
  fileChangesStatus: FileChangesStatus | null
  filePages: Map<number, FileChange[]>
  selectedFile: FileChange | null
  setSelectedFile: React.Dispatch<React.SetStateAction<FileChange | null>>
  loadingHistory: boolean
  historyHasMore: boolean
  loadingDetails: boolean
  loadHistory: (append?: boolean) => Promise<HistoryPage | null>
  loadAllHistory: () => Promise<void>
  loadingAllHistory: boolean
  resetFilter: () => void
  requestFileChangesPage: (page: number) => void
  reset: () => void
} {
  const historyRequestRef = useRef(0)
  const historyOffsetRef = useRef(0)
  const commitsRef = useRef<CommitSummary[]>([])
  const autoDateRangeRef = useRef(true)
  const suppressDateRangeReloadRef = useRef(false)
  const filePageRequestsRef = useRef(new Set<string>())
  const filePageGenerationRef = useRef(0)
  const [filter, setFilterState] = useState<HistoryFilter>(initialHistoryFilter)
  const [commits, setCommits] = useState<CommitSummary[]>([])
  const [selectedHash, setSelectedHash] = useState<string | null>(null)
  const [details, setDetails] = useState<CommitDetails | null>(null)
  const [fileChangesStatus, setFileChangesStatus] = useState<FileChangesStatus | null>(null)
  const [filePages, setFilePages] = useState<Map<number, FileChange[]>>(() => new Map())
  const [selectedFile, setSelectedFile] = useState<FileChange | null>(null)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [loadingAllHistory, setLoadingAllHistory] = useState(false)
  const [historyHasMore, setHistoryHasMore] = useState(false)
  const [loadingDetails, setLoadingDetails] = useState(false)

  useEffect(() => {
    commitsRef.current = commits
  }, [commits])

  const reset = useCallback((): void => {
    historyRequestRef.current += 1
    historyOffsetRef.current = 0
    autoDateRangeRef.current = true
    suppressDateRangeReloadRef.current = false
    filePageGenerationRef.current += 1
    filePageRequestsRef.current.clear()
    commitsRef.current = []
    setFilterState(initialHistoryFilter)
    setCommits([])
    setHistoryHasMore(false)
    setSelectedHash(null)
    setDetails(null)
    setFileChangesStatus(null)
    setFilePages(new Map())
    setSelectedFile(null)
    setLoadingHistory(false)
    setLoadingAllHistory(false)
    setLoadingDetails(false)
  }, [])

  const setFilter = useCallback<React.Dispatch<React.SetStateAction<HistoryFilter>>>((next) => {
    autoDateRangeRef.current = false
    historyRequestRef.current += 1
    setFilterState(next)
  }, [])

  const resetFilter = useCallback((): void => {
    autoDateRangeRef.current = true
    suppressDateRangeReloadRef.current = false
    historyRequestRef.current += 1
    setFilterState(initialHistoryFilter)
  }, [])

  const dateFromCommit = (commit: CommitSummary): string => commit.date.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? ''

  const updateAutomaticDateRange = useCallback((page: HistoryPage, append: boolean): void => {
    if (!autoDateRangeRef.current || page.commits.length === 0) return
    const dates = page.commits.map(dateFromCommit).filter(Boolean)
    if (dates.length === 0) return
    const pageFrom = dates.reduce((earliest, date) => date < earliest ? date : earliest, dates[0])
    const pageTo = dates.reduce((latest, date) => date > latest ? date : latest, dates[0])
    setFilterState((current) => {
      if (!autoDateRangeRef.current) return current
      const from = append && current.from ? (pageFrom < current.from ? pageFrom : current.from) : pageFrom
      const to = append && current.to ? (pageTo > current.to ? pageTo : current.to) : pageTo
      if (from === current.from && to === current.to) return current
      suppressDateRangeReloadRef.current = true
      return { ...current, from, to }
    })
  }, [])

  const loadHistory = useCallback(async (append = false) => {
    if (!repository) return null
    const requestId = ++historyRequestRef.current
    const previous = append ? commitsRef.current : []
    const offset = append ? historyOffsetRef.current : 0
    const requestFilter = autoDateRangeRef.current
      ? { ...filter, from: '', to: append ? filter.to : '' }
      : filter
    setLoadingHistory(true)
    onError('')
    try {
      const result = await window.gitHistory.loadHistory(
        repository.path,
        repository.pathScope,
        repository.pathScopeKind,
        requestFilter,
        offset
      )
      if (requestId !== historyRequestRef.current) return null
      const knownHashes = new Set(previous.map((commit) => commit.hash))
      const combined = append
        ? [...previous, ...result.commits.filter((commit) => !knownHashes.has(commit.hash))]
        : result.commits
      commitsRef.current = combined
      setCommits(combined)
      historyOffsetRef.current = result.nextOffset
      setHistoryHasMore(result.hasMore)
      updateAutomaticDateRange(result, append)
      setSelectedHash((current) => (
        current && combined.some((item) => item.hash === current)
          ? current
          : (combined[0]?.hash ?? null)
      ))
      return result
    } catch (error) {
      if (requestId !== historyRequestRef.current || isAbortError(error)) return null
      onError(error instanceof Error ? error.message : '无法读取提交历史。')
      if (!append) {
        commitsRef.current = []
        setCommits([])
        setSelectedHash(null)
        historyOffsetRef.current = 0
      }
      setHistoryHasMore(false)
      return null
    } finally {
      if (requestId === historyRequestRef.current) setLoadingHistory(false)
    }
  }, [filter, onError, repository, updateAutomaticDateRange])

  const loadAllHistory = useCallback(async (): Promise<void> => {
    if (!repository || loadingHistory || loadingAllHistory) return
    setLoadingAllHistory(true)
    try {
      let append = commitsRef.current.length > 0
      while (true) {
        const result = await loadHistory(append)
        if (!result || !result.hasMore) break
        append = true
      }
    } finally {
      setLoadingAllHistory(false)
    }
  }, [loadHistory, loadingAllHistory, loadingHistory, repository])

  useEffect(() => {
    if (!repository) return
    if (suppressDateRangeReloadRef.current) {
      suppressDateRangeReloadRef.current = false
      return
    }
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
          .startFileChangesScan(repository.path, repository.pathScope, next.hash)
          .then((status) => {
            if (!cancelled) setFileChangesStatus(status)
          })
          .catch((error) => {
            if (!cancelled && !isAbortError(error)) {
              onError(error instanceof Error ? error.message : '无法读取变更路径。')
            }
          })
      })
      .catch((error) => {
        if (!cancelled && !isAbortError(error)) {
          onError(error instanceof Error ? error.message : '无法读取提交详情。')
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingDetails(false)
      })
    return () => {
      cancelled = true
    }
  }, [onError, repository, selectedHash])

  useEffect(() => {
    if (!repository || !details || fileChangesStatus?.complete) return
    let cancelled = false
    let timer: number | undefined

    const pollStatus = async (): Promise<void> => {
      try {
        const next = await window.gitHistory.getFileChangesStatus(
          repository.path,
          repository.pathScope,
          details.hash
        )
        if (cancelled) return
        setFileChangesStatus(next)
        if (!next.complete) timer = window.setTimeout(() => void pollStatus(), 250)
      } catch (error) {
        if (!cancelled && !isAbortError(error)) {
          onError(error instanceof Error ? error.message : '无法读取变更路径。')
        }
      }
    }

    void pollStatus()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [details, fileChangesStatus?.complete, onError, repository])

  const requestFileChangesPage = useCallback((page: number): void => {
    if (!repository || !details) return
    const generation = filePageGenerationRef.current
    const requestKey = `${generation}:${page}`
    if (filePageRequestsRef.current.has(requestKey)) return
    filePageRequestsRef.current.add(requestKey)

    void window.gitHistory
      .getFileChangesPage(repository.path, repository.pathScope, details.hash, page)
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
      .catch((error) => {
        if (generation === filePageGenerationRef.current) {
          onError(error instanceof Error ? error.message : '无法读取变更路径。')
        }
      })
      .finally(() => filePageRequestsRef.current.delete(requestKey))
  }, [details, onError, repository])

  return {
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
    loadAllHistory,
    loadingAllHistory,
    resetFilter,
    requestFileChangesPage,
    reset
  }
}
