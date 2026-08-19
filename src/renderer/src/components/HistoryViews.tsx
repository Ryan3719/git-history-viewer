import { useEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown, ChevronRight, LoaderCircle } from 'lucide-react'
import type { CommitSummary, FileChange } from '../../../shared/types'

export function HistoryTable({
  commits,
  selectedHash,
  onSelect,
  formatDate
}: {
  commits: CommitSummary[]
  selectedHash: string | null
  onSelect: (hash: string) => void
  formatDate: (value: string) => string
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [expandedHashes, setExpandedHashes] = useState<Set<string>>(() => new Set())
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
        <span>Author</span>
        <span>Date</span>
        <span>Message</span>
        <span>Refs</span>
      </div>
      <div ref={scrollRef} className="log-table-scroll" role="grid" aria-label="Git 提交历史">
        {commits.length === 0 ? (
          <div className="empty-table">没有符合当前筛选条件的提交。</div>
        ) : (
          <div className="virtual-table" style={{ height: virtualizer.getTotalSize() }}>
            {rows.map((row) => {
              const commit = commits[row.index]
              const selected = selectedHash === commit.hash
              const hasBody = commit.body.trim().length > 0
              const expanded = hasBody && expandedHashes.has(commit.hash)
              return (
                <div
                  key={commit.hash}
                  className={`log-row ${selected ? 'is-selected' : ''} ${expanded ? 'is-expanded' : ''}`}
                  data-index={row.index}
                  ref={virtualizer.measureElement}
                  style={{ transform: `translateY(${row.start}px)` }}
                  role="row"
                  tabIndex={0}
                  aria-selected={selected}
                  onClick={() => onSelect(commit.hash)}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
                    event.preventDefault()
                    onSelect(commit.hash)
                  }}
                  title="单击查看变更路径"
                >
                  <span className="commit-graph" aria-hidden="true"><i /><b /></span>
                  <span className="hash-cell"><code>{commit.shortHash}</code></span>
                  <span className="author-cell">{commit.authorName}</span>
                  <span className="date-cell">{formatDate(commit.date)}</span>
                  <span className="message-cell">
                    {hasBody && (
                      <button
                        className="commit-message-toggle"
                        type="button"
                        aria-label={expanded ? '收起提交说明' : '展开提交说明'}
                        aria-expanded={expanded}
                        title={expanded ? '收起提交说明' : '展开提交说明'}
                        onClick={(event) => {
                          event.stopPropagation()
                          setExpandedHashes((hashes) => {
                            const nextHashes = new Set(hashes)
                            if (nextHashes.has(commit.hash)) {
                              nextHashes.delete(commit.hash)
                            } else {
                              nextHashes.add(commit.hash)
                            }
                            return nextHashes
                          })
                        }}
                      >
                        {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                      </button>
                    )}
                    <span className="message-heading"><strong>{commit.subject || '(无提交说明)'}</strong></span>
                    {expanded && <span className="message-body">{commit.body}</span>}
                  </span>
                  <span className="refs-cell" title={commit.refs.join('  ')}>{commit.refs.join('  ')}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}

const changeStatusLabels: Record<FileChange['status'], string> = {
  A: '新增',
  M: '修改',
  D: '删除',
  R: '重命名',
  C: '复制',
  T: '类型变更',
  U: '未合并',
  X: '未知'
}

export function FileList({
  pages,
  total,
  loading,
  selectedFile,
  pageSize,
  onSelect,
  onCompare,
  onRequestPage
}: {
  pages: Map<number, FileChange[]>
  total: number
  loading: boolean
  selectedFile: FileChange | null
  pageSize: number
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
  const visiblePageKey = [...new Set(rows.map((row) => Math.floor(row.index / pageSize)))].join(',')
  const missingVisiblePageKey = visiblePageKey
    .split(',')
    .filter((value) => value && !pages.has(Number(value)))
    .join(',')

  useEffect(() => {
    if (!missingVisiblePageKey) return
    missingVisiblePageKey.split(',').forEach((value) => onRequestPage(Number(value)))
  }, [missingVisiblePageKey, onRequestPage])

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
            const page = Math.floor(row.index / pageSize)
            const file = pages.get(page)?.[row.index % pageSize]
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
                  {changeStatusLabels[file.status]}
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
