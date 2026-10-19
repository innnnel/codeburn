// ChatAnywhere hourly usage, summed into Beijing calendar windows.
//
// POST https://api.chatanywhere.tech/v1/query/usage_details
//   Authorization is the API key itself (the usage call's documented example),
//   body { model, hours }. One call covers only the model string sent.
//   `time` is a Shanghai wall clock with no zone. `cost` is a JSON number.
//
// The model list and the key live in ~/.config/codeburn/chatanywhere.json.
// That file is created once, with an empty key, when it is missing. An existing
// file is never rewritten. Every fetch reads it again.
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { quotaRequestSignal, sanitizeError } from './security'
import type { QuotaProvider } from './types'

const USAGE_ENDPOINT = 'https://api.chatanywhere.tech/v1/query/usage_details'
const MAX_CONFIG_BYTES = 64 * 1024
const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
// Asia/Shanghai is UTC+8 and does not observe daylight saving.
const SHANGHAI_OFFSET_MS = 8 * HOUR_MS
const NOFOLLOW = constants.O_NOFOLLOW ?? 0

/** Seeded into a new config file only. Fetches never read this list. */
const INITIAL_MODELS = [
  'gpt-6.1-sol',
  'gpt-6-luna',
  'gpt-image-2.5-flare',
  'gpt-image-2.5-sunburst',
  'gpt-6-astra',
  'claude-opus-5-5',
  'claude-fable-5-1',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
]

type UsageRow = {
  time: string
  totalTokens: number
  count: number
  cost: number
}

type Totals = { cost: number; totalTokens: number; count: number }

export function chatAnywhereConfigPath(home: string = os.homedir()): string {
  return path.join(home, '.config', 'codeburn', 'chatanywhere.json')
}

function initialConfigFile(): string {
  return `${JSON.stringify({ apiKey: '', models: INITIAL_MODELS }, null, 2)}\n`
}

export type ChatAnywhereDeps = {
  fetch: typeof fetch
  configPath: string
  now: () => number
}

function defaults(): ChatAnywhereDeps {
  return {
    fetch: globalThis.fetch,
    configPath: chatAnywhereConfigPath(),
    now: Date.now,
  }
}

function empty(connection: QuotaProvider['connection']): QuotaProvider {
  return { provider: 'chatanywhere', connection, primary: null, details: [], planLabel: null, footerLines: [] }
}

/** Start of the Shanghai calendar day that contains `nowMs`, as a UTC instant. */
export function shanghaiDayStart(nowMs: number): number {
  const shifted = nowMs + SHANGHAI_OFFSET_MS
  return Math.floor(shifted / DAY_MS) * DAY_MS - SHANGHAI_OFFSET_MS
}

/** Inclusive window starts: today, the day 6 days ago, the day 29 days ago. */
export function usageWindowStarts(nowMs: number): { today: number; week: number; month: number } {
  const today = shanghaiDayStart(nowMs)
  return { today, week: today - 6 * DAY_MS, month: today - 29 * DAY_MS }
}

/** Smallest integer hour span that reaches the start of the 30-day window. */
export function hoursCovering(nowMs: number): number {
  const span = nowMs - usageWindowStarts(nowMs).month
  if (span <= 0) return 0
  return Math.ceil(span / HOUR_MS)
}

const TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/

/** `YYYY-MM-DD HH:mm:ss` read as Asia/Shanghai wall time. */
export function bucketStartMs(time: string): number | null {
  const match = TIME_PATTERN.exec(time)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null
  const utc = Date.UTC(year, month - 1, day, hour, minute, second)
  const date = new Date(utc)
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
    || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute
    || date.getUTCSeconds() !== second
  ) return null
  return utc - SHANGHAI_OFFSET_MS
}

/** Hundredths stay visible: 0.01 formats as 0.01, not 0. */
export function formatCost(cost: number): string {
  const cents = Math.round(cost * 100)
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

function formatCount(value: number): string {
  return Object.is(value, -0) ? '0' : String(value)
}

function footerLine(label: string, totals: Totals): string {
  return `${label} · ${formatCost(totals.cost)} CA · ${formatCount(totals.totalTokens)} tokens · ${formatCount(totals.count)} 次`
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseUsage(body: unknown): UsageRow[] | null {
  if (!Array.isArray(body)) return null
  const rows: UsageRow[] = []
  for (const item of body) {
    if (!item || typeof item !== 'object') return null
    const row = item as Record<string, unknown>
    if (typeof row.time !== 'string' || bucketStartMs(row.time) === null) return null
    const totalTokens = finite(row.totalTokens)
    const count = finite(row.count)
    const cost = finite(row.cost)
    if (totalTokens === null || count === null || cost === null) return null
    if (finite(row.promptTokens) === null || finite(row.completionTokens) === null) return null
    rows.push({ time: row.time, totalTokens, count, cost })
  }
  return rows
}

function retryAfterSeconds(response: Response): number {
  const raw = response.headers.get('Retry-After')
  const seconds = raw === null ? NaN : Number(raw)
  return Math.max(Number.isFinite(seconds) ? Math.ceil(seconds) : 300, 60)
}

async function readConfigFile(filePath: string): Promise<string | null> {
  let stat
  try {
    stat = await lstat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link: ${filePath}`)
  if (!stat.isFile()) throw new Error(`Config path is not a regular file: ${filePath}`)
  if (stat.size > MAX_CONFIG_BYTES) throw new Error(`Config file exceeds ${MAX_CONFIG_BYTES} bytes: ${filePath}`)
  return await readFile(filePath, 'utf8')
}

/** Creates the file only when the path is absent. An existing file is left as it is. */
async function createConfigFile(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  let handle
  try {
    handle = await open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return
    throw error
  }
  try {
    await handle.writeFile(contents, 'utf8')
  } catch (error) {
    await handle.close()
    await unlink(filePath).catch(() => undefined)
    throw error
  }
  await handle.close()
  if (process.platform !== 'win32') await chmod(filePath, 0o600)
}

type LoadedConfig =
  | { kind: 'ready'; apiKey: string; models: string[] }
  | { kind: 'disconnected' }
  | { kind: 'transient' }

async function loadConfig(configPath: string): Promise<LoadedConfig> {
  let raw: string | null
  try {
    raw = await readConfigFile(configPath)
    if (raw === null) {
      await createConfigFile(configPath, initialConfigFile())
      raw = await readConfigFile(configPath)
    }
  } catch (error) {
    console.warn(`ChatAnywhere config unavailable: ${sanitizeError(error)}`)
    return { kind: 'transient' }
  }
  if (raw === null) return { kind: 'transient' }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'transient' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'transient' }
  const record = parsed as Record<string, unknown>
  const apiKey = typeof record.apiKey === 'string' ? record.apiKey.trim() : ''
  const models = Array.isArray(record.models)
    ? record.models.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : []
  if (!apiKey || models.length === 0) return { kind: 'disconnected' }
  return { kind: 'ready', apiKey, models }
}

export type ChatAnywhereResult = { quota: QuotaProvider; retryAfterSeconds?: number }

type QueryOutcome = { rows: UsageRow[] } | { failure: ChatAnywhereResult }

async function queryModel(
  deps: ChatAnywhereDeps,
  apiKey: string,
  model: string,
  hours: number,
  signal: AbortSignal | undefined,
): Promise<QueryOutcome> {
  let response: Response
  try {
    response = await deps.fetch(USAGE_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({ model, hours }),
      signal: quotaRequestSignal(signal),
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    })
  } catch (error) {
    console.warn(`ChatAnywhere quota unavailable: ${sanitizeError(error)}`)
    return { failure: { quota: empty('transientFailure') } }
  }

  if (response.status === 429) {
    return {
      failure: {
        quota: { ...empty('transientFailure'), rateLimited: true },
        retryAfterSeconds: retryAfterSeconds(response),
      },
    }
  }
  if (!response.ok) {
    const connection = response.status >= 400 && response.status < 500 ? 'terminalFailure' : 'transientFailure'
    const connectable = response.status === 401 || response.status === 403
    return { failure: { quota: { ...empty(connection), ...(connectable ? { connectable: true } : {}) } } }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    console.warn(`ChatAnywhere quota unavailable: ${sanitizeError(error)}`)
    return { failure: { quota: empty('transientFailure') } }
  }
  const rows = parseUsage(body)
  if (!rows) return { failure: { quota: empty('transientFailure') } }
  return { rows }
}

function sumWindows(groups: UsageRow[][], nowMs: number): string[] {
  const starts = usageWindowStarts(nowMs)
  const windows = [
    { label: '当天', startMs: starts.today },
    { label: '7 天', startMs: starts.week },
    { label: '30 天', startMs: starts.month },
  ]
  return windows.map(window => {
    const totals: Totals = { cost: 0, totalTokens: 0, count: 0 }
    for (const rows of groups) {
      for (const row of rows) {
        const start = bucketStartMs(row.time)
        if (start === null || start < window.startMs || start > nowMs) continue
        totals.cost += row.cost
        totals.totalTokens += row.totalTokens
        totals.count += row.count
      }
    }
    return footerLine(window.label, totals)
  })
}

export async function fetchChatAnywhereQuota(
  options: Partial<ChatAnywhereDeps> & { signal?: AbortSignal } = {},
): Promise<ChatAnywhereResult> {
  const deps = { ...defaults(), ...options }
  const loaded = await loadConfig(deps.configPath)
  if (loaded.kind === 'transient') return { quota: empty('transientFailure') }
  if (loaded.kind === 'disconnected') return { quota: empty('disconnected') }

  const now = deps.now()
  const hours = hoursCovering(now)
  const groups: UsageRow[][] = []
  for (const model of loaded.models) {
    if (options.signal?.aborted) return { quota: empty('transientFailure') }
    const outcome = await queryModel(deps, loaded.apiKey, model, hours, options.signal)
    if ('failure' in outcome) return outcome.failure
    groups.push(outcome.rows)
  }

  return {
    quota: {
      provider: 'chatanywhere',
      connection: 'connected',
      primary: null,
      details: [],
      planLabel: null,
      footerLines: sumWindows(groups, now),
    },
  }
}
