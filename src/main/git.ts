import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { access, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  ChangeStatus,
  CommitDetails,
  CommitSummary,
  ExternalDiffRequest,
  FileChange,
  FileChangesPage,
  HistoryFilter,
  HistoryPage,
  RepositoryInfo
} from '../shared/types'

const FIELD_SEPARATOR = '\u001f'
const RECORD_SEPARATOR = '\u001e'
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024
const FILE_CHANGES_PAGE_SIZE = 200
const MAX_FILE_CHANGES_CACHES = 4

interface GitRunOptions {
  maxOutputBytes?: number
  signal?: AbortSignal
}

interface FileChangesCache {
  key: string
  directory: string
  filePath: string
  pageOffsets: number[]
  total: number
  lastUsed: number
  ready: Promise<void>
}

const fileChangesCaches = new Map<string, FileChangesCache>()
let fileChangesCacheUsage = 0

function abortError(): Error {
  const error = new Error('Git 读取已取消。')
  error.name = 'AbortError'
  return error
}

export function runGit(
  cwd: string | undefined,
  args: string[],
  options: GitRunOptions = {}
): Promise<Buffer> {
  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES
  if (options.signal?.aborted) return Promise.reject(abortError())

  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_PAGER: 'cat'
      }
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let size = 0
    let overflow = false
    let aborted = false

    const abort = (): void => {
      aborted = true
      child.kill()
    }
    const cleanupAbortListener = (): void => options.signal?.removeEventListener('abort', abort)

    const append = (target: Buffer[], chunk: Buffer): void => {
      size += chunk.length
      if (size > maxOutputBytes) {
        overflow = true
        child.kill()
        return
      }
      target.push(chunk)
    }

    child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk))
    child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk))
    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener('abort', abort, { once: true })
    child.once('error', (error) => {
      cleanupAbortListener()
      reject(aborted ? abortError() : new Error(`无法启动 git：${error.message}`))
    })
    child.once('close', (code) => {
      cleanupAbortListener()
      if (aborted) {
        reject(abortError())
        return
      }
      if (overflow) {
        reject(new Error('Git 输出过大，已停止读取。请缩小筛选范围或改用外部对比工具。'))
        return
      }
      if (code === 0) {
        resolve(Buffer.concat(stdout))
        return
      }
      const detail = Buffer.concat(stderr).toString('utf8').trim()
      reject(new Error(detail || `git ${args[0] ?? ''} 执行失败`))
    })
  })
}

async function runGitText(cwd: string | undefined, args: string[]): Promise<string> {
  return (await runGit(cwd, args)).toString('utf8').trim()
}

async function tryGitText(cwd: string | undefined, args: string[]): Promise<string> {
  try {
    return await runGitText(cwd, args)
  } catch {
    return ''
  }
}

export async function getRepositoryInfo(repositoryPath: string): Promise<RepositoryInfo> {
  const root = await runGitText(repositoryPath, ['rev-parse', '--show-toplevel'])
  const branch = (await tryGitText(root, ['branch', '--show-current'])) || 'DETACHED'
  const head = await tryGitText(root, ['rev-parse', '--short', 'HEAD'])
  const segments = root.replace(/[\\/]+$/, '').split(/[\\/]/)

  return {
    path: root,
    name: segments.at(-1) || root,
    branch,
    head
  }
}

function parseRefs(value: string): string[] {
  return value
    .split(',')
    .map((ref) => ref.trim())
    .filter(Boolean)
}

function parseCommitRecords(output: string): CommitSummary[] {
  return output
    .split(RECORD_SEPARATOR)
    .filter(Boolean)
    .map((record) => {
      const [hash, parents, authorName, authorEmail, date, subject, refs] = record.split(FIELD_SEPARATOR)
      return {
        hash,
        shortHash: hash.slice(0, 8),
        parents: parents ? parents.split(' ') : [],
        authorName,
        authorEmail,
        date,
        subject,
        refs: parseRefs(refs || '')
      }
    })
}

function dateArguments(filter: HistoryFilter): string[] {
  const args: string[] = []
  if (filter.from) args.push(`--since=${filter.from}T00:00:00`)
  if (filter.to) args.push(`--until=${filter.to}T23:59:59`)
  return args
}

function pathspecFor(query: string): string {
  const normalized = query.replace(/\\/g, '/')
  return `:(glob)**/*${normalized}*`
}

export async function listCommits(
  repositoryPath: string,
  filter: HistoryFilter,
  signal?: AbortSignal,
  offset = 0
): Promise<HistoryPage> {
  const query = filter.query.trim()
  const pageLimit = Math.max(1, filter.limit)
  const args = [
    'log',
    '--all',
    '--date=iso-strict',
    `--max-count=${pageLimit + 1}`,
    `--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%D`,
    ...dateArguments(filter)
  ]

  if (offset > 0) args.push(`--skip=${offset}`)

  if (query && filter.scope === 'message') args.push(`--grep=${query}`)
  if (query && filter.scope === 'author') args.push(`--author=${query}`)
  if (query && filter.scope === 'path') args.push('--', pathspecFor(query))

  const rawCommits = parseCommitRecords((await runGit(repositoryPath, args, { signal })).toString('utf8'))
  const hasMore = rawCommits.length > pageLimit
  const commits = rawCommits.slice(0, pageLimit)
  const nextOffset = offset + commits.length
  if (!query || ['message', 'author', 'path'].includes(filter.scope)) {
    return { commits, hasMore, nextOffset }
  }

  const needle = query.toLocaleLowerCase()
  return {
    commits: commits.filter((commit) => {
    if (filter.scope === 'hash') return commit.hash.toLocaleLowerCase().startsWith(needle)
    return [commit.hash, commit.subject, commit.authorName, commit.authorEmail, ...commit.refs]
      .join('\n')
      .toLocaleLowerCase()
      .includes(needle)
    }),
    hasMore,
    nextOffset
  }
}

function normalizeStatus(value: string): ChangeStatus {
  const status = value.charAt(0)
  if (['A', 'M', 'D', 'R', 'C', 'T', 'U'].includes(status)) return status as ChangeStatus
  return 'X'
}

function fileChangesCacheKey(repositoryPath: string, hash: string): string {
  return `${repositoryPath}\u0000${hash}`
}

function touchFileChangesCache(cache: FileChangesCache): void {
  cache.lastUsed = ++fileChangesCacheUsage
}

function evictFileChangesCaches(currentKey: string): void {
  const candidates = [...fileChangesCaches.values()]
    .filter((cache) => cache.key !== currentKey)
    .sort((left, right) => left.lastUsed - right.lastUsed)

  while (fileChangesCaches.size > MAX_FILE_CHANGES_CACHES && candidates.length > 0) {
    const stale = candidates.shift()
    if (!stale) break
    fileChangesCaches.delete(stale.key)
    void rm(stale.directory, { recursive: true, force: true })
  }
}

function populateFileChangesCache(
  cache: FileChangesCache,
  repositoryPath: string,
  hash: string,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError())

  return new Promise((resolve, reject) => {
    const child = spawn('git', [
      'diff-tree',
      '--root',
      '--no-commit-id',
      '--name-status',
      '-r',
      '-M',
      '-z',
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
    const output = createWriteStream(cache.filePath)
    const stderr: Buffer[] = []
    let stderrSize = 0
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let status: ChangeStatus | null = null
    let previousPath: string | undefined
    let expectedPaths = 0
    let byteOffset = 0
    let aborted = false
    let settled = false
    let waitingForDrain = false

    const cleanupAbortListener = (): void => signal?.removeEventListener('abort', abort)
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanupAbortListener()
      child.kill()
      output.destroy()
      reject(error)
    }
    const abort = (): void => {
      aborted = true
      pending = Buffer.alloc(0)
      child.kill()
    }
    const writeChange = (change: FileChange): void => {
      const line = Buffer.from(`${JSON.stringify(change)}\n`, 'utf8')
      byteOffset += line.length
      cache.total += 1
      if (cache.total % FILE_CHANGES_PAGE_SIZE === 0) cache.pageOffsets.push(byteOffset)
      if (!output.write(line) && !waitingForDrain) {
        waitingForDrain = true
        child.stdout.pause()
        output.once('drain', () => {
          waitingForDrain = false
          child.stdout.resume()
        })
      }
    }
    const processField = (field: Buffer): void => {
      const value = field.toString('utf8')
      if (expectedPaths === 0) {
        if (!value) return
        status = normalizeStatus(value)
        expectedPaths = status === 'R' || status === 'C' ? 2 : 1
        previousPath = undefined
        return
      }
      if ((status === 'R' || status === 'C') && expectedPaths === 2) {
        previousPath = value
        expectedPaths = 1
        return
      }
      if (status && value) writeChange({ status, path: value, previousPath })
      status = null
      previousPath = undefined
      expectedPaths = 0
    }

    child.stdout.on('data', (chunk: Buffer) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
      let separatorIndex = pending.indexOf(0)
      while (separatorIndex !== -1) {
        processField(pending.subarray(0, separatorIndex))
        pending = pending.subarray(separatorIndex + 1)
        separatorIndex = pending.indexOf(0)
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrSize >= 64 * 1024) return
      stderrSize += chunk.length
      stderr.push(chunk)
    })
    child.once('error', (error) => fail(aborted ? abortError() : new Error(`无法启动 git：${error.message}`)))
    output.once('error', (error) => fail(new Error(`无法写入变更路径缓存：${error.message}`)))
    output.once('finish', () => {
      if (settled) return
      settled = true
      cleanupAbortListener()
      resolve()
    })
    child.once('close', (code) => {
      if (aborted) {
        fail(abortError())
        return
      }
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString('utf8').trim()
        fail(new Error(detail || 'git diff-tree 执行失败'))
        return
      }
      output.end()
    })
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

async function getFileChangesCache(
  repositoryPath: string,
  hash: string,
  signal?: AbortSignal
): Promise<FileChangesCache> {
  const key = fileChangesCacheKey(repositoryPath, hash)
  const existing = fileChangesCaches.get(key)
  if (existing) {
    await existing.ready
    touchFileChangesCache(existing)
    return existing
  }

  const directory = await mkdtemp(join(tmpdir(), 'git-history-viewer-paths-'))
  const cache: FileChangesCache = {
    key,
    directory,
    filePath: join(directory, 'paths.ndjson'),
    pageOffsets: [0],
    total: 0,
    lastUsed: ++fileChangesCacheUsage,
    ready: Promise.resolve()
  }
  cache.ready = populateFileChangesCache(cache, repositoryPath, hash, signal).catch(async (error: unknown) => {
    fileChangesCaches.delete(key)
    await rm(directory, { recursive: true, force: true })
    throw error
  })
  fileChangesCaches.set(key, cache)

  await cache.ready
  touchFileChangesCache(cache)
  evictFileChangesCaches(key)
  return cache
}

export async function getFileChangesPage(
  repositoryPath: string,
  hash: string,
  page: number,
  signal?: AbortSignal
): Promise<FileChangesPage> {
  const cache = await getFileChangesCache(repositoryPath, hash, signal)
  const normalizedPage = Math.max(0, Math.floor(page))
  const startIndex = normalizedPage * FILE_CHANGES_PAGE_SIZE
  if (startIndex >= cache.total) {
    return { page: normalizedPage, pageSize: FILE_CHANGES_PAGE_SIZE, total: cache.total, changes: [] }
  }

  const start = cache.pageOffsets[normalizedPage]
  const handle = await open(cache.filePath, 'r')
  try {
    const end = cache.pageOffsets[normalizedPage + 1] ?? (await handle.stat()).size
    const length = end - start
    const buffer = Buffer.allocUnsafe(length)
    let position = 0
    while (position < buffer.length) {
      const { bytesRead } = await handle.read(buffer, position, buffer.length - position, start + position)
      if (bytesRead === 0) break
      position += bytesRead
    }
    const changes = buffer
      .subarray(0, position)
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FileChange)
    touchFileChangesCache(cache)
    return { page: normalizedPage, pageSize: FILE_CHANGES_PAGE_SIZE, total: cache.total, changes }
  } finally {
    await handle.close()
  }
}

export async function getCommitDetails(
  repositoryPath: string,
  hash: string,
  signal?: AbortSignal
): Promise<CommitDetails> {
  const [raw, cache] = await Promise.all([
    runGit(repositoryPath, ['show', '-s', '--format=%H%x1f%P', hash], { signal }),
    getFileChangesCache(repositoryPath, hash, signal)
  ])
  const [commitHash, parents] = raw.toString('utf8').trim().split(FIELD_SEPARATOR)

  return {
    hash: commitHash,
    parents: parents ? parents.split(' ') : [],
    fileChangesTotal: cache.total
  }
}

function streamBlobToFile(
  repositoryPath: string,
  revision: string | undefined,
  filePath: string,
  destination: string
): Promise<void> {
  if (!revision) return writeFile(destination, Buffer.alloc(0))

  return new Promise((resolve, reject) => {
    const child = spawn('git', ['show', `${revision}:${filePath}`], {
      cwd: repositoryPath,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_PAGER: 'cat'
      }
    })
    const output = createWriteStream(destination)
    const stderr: Buffer[] = []
    let stderrSize = 0
    let closed = false
    let finished = false
    let settled = false

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      child.kill()
      output.destroy()
      reject(error)
    }
    const complete = (): void => {
      if (!settled && closed && finished) {
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
    output.once('error', (error) => fail(new Error(`无法写入临时对比文件：${error.message}`)))
    output.once('finish', () => {
      finished = true
      complete()
    })
    child.once('close', (code) => {
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString('utf8').trim()
        fail(new Error(detail || 'git show 执行失败'))
        return
      }
      closed = true
      complete()
    })
  })
}

export async function writeComparisonFiles(
  request: Pick<ExternalDiffRequest, 'repositoryPath' | 'commitHash' | 'parentHash' | 'file'>,
  left: string,
  right: string
): Promise<void> {
  const { repositoryPath, commitHash, parentHash, file } = request
  const leftPath = file.previousPath ?? file.path
  await Promise.all([
    file.status === 'A'
      ? writeFile(left, Buffer.alloc(0))
      : streamBlobToFile(repositoryPath, parentHash, leftPath, left),
    file.status === 'D'
      ? writeFile(right, Buffer.alloc(0))
      : streamBlobToFile(repositoryPath, commitHash, file.path, right)
  ])
}

export async function cloneRemoteRepository(url: string, destination: string): Promise<RepositoryInfo> {
  try {
    await access(destination)
    throw new Error('目标目录已经存在。请选择一个不存在的目录。')
  } catch (error) {
    if (error instanceof Error && error.message.includes('目标目录已经存在')) throw error
  }
  await mkdir(dirname(destination), { recursive: true })
  await runGit(dirname(destination), ['clone', '--filter=blob:none', '--no-checkout', url, destination], {
    maxOutputBytes: 64 * 1024 * 1024
  })
  return getRepositoryInfo(destination)
}
