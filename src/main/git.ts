import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, mkdir, open, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  ChangeStatus,
  CommitDetails,
  CommitSummary,
  ExternalDiffRequest,
  FileChange,
  FileChangesPage,
  FileChangesStatus,
  HistoryFilter,
  HistoryPage,
  RepositoryInfo
} from '../shared/types'

const FIELD_SEPARATOR = '\u001f'
const RECORD_SEPARATOR = '\u001e'
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024
const FILE_CHANGES_PAGE_SIZE = 200
const INITIAL_FILE_CHANGES_AVAILABLE = 50
const MAX_FILE_CHANGES_CACHES = 4
const MAX_RENAME_CANDIDATES = 2_000
const FILE_CHANGES_CACHE_VERSION = 2
const MAX_PERSISTENT_FILE_CHANGES_CACHE_BYTES = 512 * 1024 * 1024
const MAX_PERSISTENT_FILE_CHANGES_CACHE_AGE_MS = 30 * 24 * 60 * 60 * 1000

interface GitRunOptions {
  maxOutputBytes?: number
  signal?: AbortSignal
}

interface FileChangesCache {
  key: string
  storageKey: string
  repositoryPath: string
  hash: string
  filePath: string
  finalFilePath: string
  metadataFilePath: string
  pageOffsets: number[]
  total: number
  availableCount: number
  complete: boolean
  error: Error | null
  progressWaiters: Set<() => void>
  lastUsed: number
  initialized: Promise<void>
  completion: Promise<void>
}

const fileChangesCaches = new Map<string, FileChangesCache>()
let fileChangesCacheUsage = 0
let fileChangesCacheDirectory = ''

interface PersistedFileChangesCache {
  version: number
  repositoryPath: string
  hash: string
  pageOffsets: number[]
  total: number
}

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
  let root: string
  try {
    root = await runGitText(repositoryPath, ['rev-parse', '--show-toplevel'])
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (/not a git repository|不是.*git.*仓库/i.test(message)) {
      throw new Error('不是 Git 仓库。')
    }
    throw error
  }
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

function fileChangesStorageKey(repositoryPath: string, hash: string): string {
  return createHash('sha256').update(fileChangesCacheKey(repositoryPath, hash)).digest('hex')
}

function currentFileChangesCacheDirectory(): string {
  return fileChangesCacheDirectory || join(process.env.TEMP || process.env.TMP || '.', 'git-history-viewer-file-changes')
}

export function configureFileChangesCacheDirectory(directory: string): void {
  fileChangesCacheDirectory = directory
  void cleanPersistentFileChangesCaches()
}

function touchFileChangesCache(cache: FileChangesCache): void {
  cache.lastUsed = ++fileChangesCacheUsage
  if (cache.complete && cache.filePath === cache.finalFilePath) {
    const now = new Date()
    void Promise.all([
      utimes(cache.filePath, now, now),
      utimes(cache.metadataFilePath, now, now)
    ]).catch(() => undefined)
  }
}

function evictFileChangesCaches(currentKey: string): void {
  const candidates = [...fileChangesCaches.values()]
    .filter((cache) => cache.key !== currentKey)
    .sort((left, right) => left.lastUsed - right.lastUsed)

  while (fileChangesCaches.size > MAX_FILE_CHANGES_CACHES && candidates.length > 0) {
    const stale = candidates.shift()
    if (!stale) break
    fileChangesCaches.delete(stale.key)
  }
}

function notifyFileChangesProgress(cache: FileChangesCache): void {
  const waiters = [...cache.progressWaiters]
  cache.progressWaiters.clear()
  waiters.forEach((resolve) => resolve())
}

function fileChangesStatus(cache: FileChangesCache): FileChangesStatus {
  return {
    scannedCount: cache.total,
    availableCount: cache.availableCount,
    complete: cache.complete
  }
}

function isValidPersistedCache(value: unknown, fileSize: number, repositoryPath: string, hash: string): value is PersistedFileChangesCache {
  if (!value || typeof value !== 'object') return false
  const cache = value as Partial<PersistedFileChangesCache>
  const total = cache.total
  const pageOffsets = cache.pageOffsets
  if (
    cache.version !== FILE_CHANGES_CACHE_VERSION ||
    cache.repositoryPath !== repositoryPath ||
    cache.hash !== hash ||
    typeof total !== 'number' ||
    !Number.isSafeInteger(total) ||
    total < 0 ||
    !Array.isArray(pageOffsets)
  ) {
    return false
  }

  const expectedOffsets = Math.floor(total / FILE_CHANGES_PAGE_SIZE) + 1
  if (pageOffsets.length !== expectedOffsets || pageOffsets[0] !== 0) return false
  return pageOffsets.every((offset, index) => (
    Number.isSafeInteger(offset) &&
    offset >= 0 &&
    offset <= fileSize &&
    (index === 0 || offset >= pageOffsets[index - 1])
  ))
}

async function removePersistentFileChangesCache(storageKey: string): Promise<void> {
  const directory = currentFileChangesCacheDirectory()
  await Promise.all([
    rm(join(directory, `${storageKey}.paths.ndjson`), { force: true }),
    rm(join(directory, `${storageKey}.paths.json`), { force: true }),
    rm(join(directory, `${storageKey}.paths.part`), { force: true })
  ])
}

async function cleanPersistentFileChangesCaches(): Promise<void> {
  const directory = currentFileChangesCacheDirectory()
  try {
    await mkdir(directory, { recursive: true })
    const entries = await readdir(directory, { withFileTypes: true })
    const now = Date.now()
    const protectedPaths = new Set([...fileChangesCaches.values()].map((cache) => cache.filePath))
    const candidates: Array<{ storageKey: string; filePath: string; size: number; lastUsedAt: number }> = []

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.paths.ndjson')) continue
      const filePath = join(directory, entry.name)
      const storageKey = entry.name.slice(0, -'.paths.ndjson'.length)
      const info = await stat(filePath)
      if (protectedPaths.has(filePath)) {
        candidates.push({ storageKey, filePath, size: info.size, lastUsedAt: info.mtimeMs })
        continue
      }
      if (now - info.mtimeMs > MAX_PERSISTENT_FILE_CHANGES_CACHE_AGE_MS) {
        await removePersistentFileChangesCache(storageKey)
        continue
      }
      candidates.push({ storageKey, filePath, size: info.size, lastUsedAt: info.mtimeMs })
    }

    let totalSize = candidates.reduce((total, item) => total + item.size, 0)
    for (const candidate of candidates.sort((left, right) => left.lastUsedAt - right.lastUsedAt)) {
      if (totalSize <= MAX_PERSISTENT_FILE_CHANGES_CACHE_BYTES || protectedPaths.has(candidate.filePath)) continue
      await removePersistentFileChangesCache(candidate.storageKey)
      totalSize -= candidate.size
    }
  } catch {
    // Cache maintenance must never affect repository browsing.
  }
}

async function loadPersistentFileChangesCache(cache: FileChangesCache): Promise<boolean> {
  try {
    const [rawMetadata, fileInfo] = await Promise.all([
      readFile(cache.metadataFilePath, 'utf8'),
      stat(cache.finalFilePath)
    ])
    const metadata = JSON.parse(rawMetadata) as unknown
    if (!isValidPersistedCache(metadata, fileInfo.size, cache.repositoryPath, cache.hash)) {
      throw new Error('变更路径缓存无效')
    }

    cache.filePath = cache.finalFilePath
    cache.pageOffsets = metadata.pageOffsets
    cache.total = metadata.total
    cache.availableCount = metadata.total
    cache.complete = true
    cache.completion = Promise.resolve()
    touchFileChangesCache(cache)
    return true
  } catch {
    await removePersistentFileChangesCache(cache.storageKey)
    return false
  }
}

async function persistFileChangesCache(cache: FileChangesCache): Promise<void> {
  await rm(cache.finalFilePath, { force: true })
  await rename(cache.filePath, cache.finalFilePath)
  cache.filePath = cache.finalFilePath

  const metadata: PersistedFileChangesCache = {
    version: FILE_CHANGES_CACHE_VERSION,
    repositoryPath: cache.repositoryPath,
    hash: cache.hash,
    pageOffsets: cache.pageOffsets,
    total: cache.total
  }
  const temporaryMetadataPath = `${cache.metadataFilePath}.${randomUUID()}.tmp`
  await writeFile(temporaryMetadataPath, JSON.stringify(metadata), 'utf8')
  await rm(cache.metadataFilePath, { force: true })
  await rename(temporaryMetadataPath, cache.metadataFilePath)
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
      `-l${MAX_RENAME_CANDIDATES}`,
      '-z',
      hash
    ], {
      cwd: repositoryPath,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_PAGER: 'cat',
        LC_ALL: 'C',
        LANG: 'C'
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
      const completedPage = cache.total % FILE_CHANGES_PAGE_SIZE === 0
      const shouldPublish = completedPage || cache.total === INITIAL_FILE_CHANGES_AVAILABLE
      const publishedCount = cache.total
      if (completedPage) cache.pageOffsets.push(byteOffset)
      const markPageReady = (error?: Error | null): void => {
        if (error) {
          fail(new Error(`无法写入变更路径缓存：${error.message}`))
          return
        }
        if (!shouldPublish) return
        cache.availableCount = Math.max(cache.availableCount, publishedCount)
        notifyFileChangesProgress(cache)
      }
      const written = shouldPublish ? output.write(line, markPageReady) : output.write(line)
      if (!written && !waitingForDrain) {
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

async function initializeFileChangesCache(
  cache: FileChangesCache,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw abortError()
  await mkdir(currentFileChangesCacheDirectory(), { recursive: true })
  if (await loadPersistentFileChangesCache(cache)) return

  cache.filePath = `${cache.finalFilePath}.${randomUUID()}.part`
  cache.completion = populateFileChangesCache(cache, cache.repositoryPath, cache.hash, signal)
    .then(async () => {
      await persistFileChangesCache(cache)
      cache.availableCount = cache.total
      cache.complete = true
      notifyFileChangesProgress(cache)
      void cleanPersistentFileChangesCaches()
    })
    .catch(async (error: unknown) => {
      const failure = error instanceof Error ? error : new Error('无法读取变更路径。')
      cache.error = failure
      notifyFileChangesProgress(cache)
      fileChangesCaches.delete(cache.key)
      await Promise.all([
        rm(cache.filePath, { force: true }),
        rm(cache.finalFilePath, { force: true }),
        rm(cache.metadataFilePath, { force: true })
      ])
      throw failure
    })
  void cache.completion.catch(() => undefined)
}

async function getFileChangesCache(
  repositoryPath: string,
  hash: string,
  signal?: AbortSignal
): Promise<FileChangesCache> {
  const key = fileChangesCacheKey(repositoryPath, hash)
  const existing = fileChangesCaches.get(key)
  if (existing) {
    await existing.initialized
    touchFileChangesCache(existing)
    return existing
  }

  const storageKey = fileChangesStorageKey(repositoryPath, hash)
  const directory = currentFileChangesCacheDirectory()
  const cache: FileChangesCache = {
    key,
    storageKey,
    repositoryPath,
    hash,
    filePath: '',
    finalFilePath: join(directory, `${storageKey}.paths.ndjson`),
    metadataFilePath: join(directory, `${storageKey}.paths.json`),
    pageOffsets: [0],
    total: 0,
    availableCount: 0,
    complete: false,
    error: null,
    progressWaiters: new Set(),
    lastUsed: ++fileChangesCacheUsage,
    initialized: Promise.resolve(),
    completion: Promise.resolve()
  }
  fileChangesCaches.set(key, cache)
  cache.initialized = initializeFileChangesCache(cache, signal).catch((error: unknown) => {
    fileChangesCaches.delete(key)
    throw error
  })

  await cache.initialized
  touchFileChangesCache(cache)
  if (cache.complete) evictFileChangesCaches(key)
  return cache
}

async function waitForFileChangesPage(cache: FileChangesCache, page: number): Promise<void> {
  const startIndex = page * FILE_CHANGES_PAGE_SIZE
  while (!cache.complete && startIndex >= cache.availableCount && !cache.error) {
    await new Promise<void>((resolve) => cache.progressWaiters.add(resolve))
  }
  if (cache.error) throw cache.error
}

async function readFileChangesPage(cache: FileChangesCache, page: number): Promise<FileChange[]> {
  const startIndex = page * FILE_CHANGES_PAGE_SIZE
  if (startIndex >= cache.total) return []

  const start = cache.pageOffsets[page]
  if (start === undefined) return []
  const handle = await open(cache.filePath, 'r')
  try {
    const end = cache.pageOffsets[page + 1] ?? (await handle.stat()).size
    const length = end - start
    const buffer = Buffer.allocUnsafe(length)
    let position = 0
    while (position < buffer.length) {
      const { bytesRead } = await handle.read(buffer, position, buffer.length - position, start + position)
      if (bytesRead === 0) break
      position += bytesRead
    }
    return buffer
      .subarray(0, position)
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FileChange)
  } finally {
    await handle.close()
  }
}

export async function startFileChangesScan(
  repositoryPath: string,
  hash: string,
  signal?: AbortSignal
): Promise<FileChangesStatus> {
  const cache = await getFileChangesCache(repositoryPath, hash, signal)
  return fileChangesStatus(cache)
}

export async function getFileChangesStatus(repositoryPath: string, hash: string): Promise<FileChangesStatus> {
  const cache = fileChangesCaches.get(fileChangesCacheKey(repositoryPath, hash))
  if (!cache) throw abortError()
  await cache.initialized
  if (cache.error) throw cache.error
  return fileChangesStatus(cache)
}

export async function getFileChangesPage(
  repositoryPath: string,
  hash: string,
  page: number,
  signal?: AbortSignal
): Promise<FileChangesPage> {
  const cache = await getFileChangesCache(repositoryPath, hash, signal)
  const normalizedPage = Math.max(0, Math.floor(page))
  await waitForFileChangesPage(cache, normalizedPage)
  const changes = await readFileChangesPage(cache, normalizedPage)
  touchFileChangesCache(cache)
  return {
    page: normalizedPage,
    pageSize: FILE_CHANGES_PAGE_SIZE,
    changes,
    ...fileChangesStatus(cache)
  }
}

export async function getCommitDetails(
  repositoryPath: string,
  hash: string,
  signal?: AbortSignal
): Promise<CommitDetails> {
  const raw = await runGit(repositoryPath, ['show', '-s', '--format=%H%x1f%P', hash], { signal })
  const [commitHash, parents] = raw.toString('utf8').trim().split(FIELD_SEPARATOR)

  return {
    hash: commitHash,
    parents: parents ? parents.split(' ') : []
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
