// Live ChatAnywhere balance (CA, 人民币). The console session the user pastes
// from localStorage `chatanywhere-session` lives at
// ~/.config/codeburn/chatanywhere.json and is re-read on every fetch.
//
// Each fetch refreshes first. code 0 merges `{ ...session, ...data }` and
// writes that object back before overview — the refresh token rotates, and the
// previous access token is never reused. code !== 0 on either call is a
// connectable terminal failure. There is no usage window and no usage_details
// call: the card is one footer line, Balance · {amount} CA, hundredths kept.
import os from 'node:os'
import path from 'node:path'

import { atomicWriteSecureFileSync, quotaRequestSignal, readSecureFile, sanitizeError } from './security'
import type { QuotaProvider } from './types'

const REFRESH_URL = 'https://chatanywhere.tech/api/console/auth/refresh'
const OVERVIEW_URL = 'https://chatanywhere.tech/api/console/overview'

export const CHATANYWHERE_REPASTE_FOOTER = 'Paste chatanywhere-session into ~/.config/codeburn/chatanywhere.json again, then refresh.'

export function chatanywhereCredentialPath(home = os.homedir()): string {
  return path.join(home, '.config', 'codeburn', 'chatanywhere.json')
}

/** Hundredths, including trailing zeros (`1` → `1.00`). */
export function formatChatanywhereAmount(amount: number): string {
  return amount.toFixed(2)
}

export function chatanywhereBalanceLine(amount: number): string {
  return `Balance · ${formatChatanywhereAmount(amount)} CA`
}

export type ChatanywhereDeps = {
  fetch: typeof fetch
  credentialPath: string
  readFile: typeof readSecureFile
  writeFileSync: typeof atomicWriteSecureFileSync
}

const defaults: ChatanywhereDeps = {
  fetch: globalThis.fetch,
  credentialPath: chatanywhereCredentialPath(),
  readFile: readSecureFile,
  writeFileSync: atomicWriteSecureFileSync,
}

function empty(connection: QuotaProvider['connection'], footerLines: string[] = []): QuotaProvider {
  return { provider: 'chatanywhere', connection, primary: null, details: [], planLabel: null, footerLines }
}

function repaste(): QuotaProvider {
  return { ...empty('terminalFailure', [CHATANYWHERE_REPASTE_FOOTER]), connectable: true }
}

type ApiBody = { code: number; data: unknown }

async function postJson(
  deps: ChatanywhereDeps,
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<ApiBody | 'transport'> {
  const response = await deps.fetch(url, {
    method: 'POST',
    signal: quotaRequestSignal(signal),
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  let parsed: unknown
  try { parsed = await response.json() } catch { return 'transport' }
  if (!parsed || typeof parsed !== 'object') return 'transport'
  const code = (parsed as { code?: unknown }).code
  if (typeof code !== 'number') return 'transport'
  return { code, data: (parsed as { data?: unknown }).data }
}

/** `{ ...session, ...data }` when both are objects and the merge still has both tokens. */
function mergeSession(session: Record<string, unknown>, data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const next = { ...session, ...(data as Record<string, unknown>) }
  if (typeof next.accessToken !== 'string' || !next.accessToken) return null
  if (typeof next.refreshToken !== 'string' || !next.refreshToken) return null
  return next
}

function balanceOf(data: unknown): number | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const balance = (data as { balance?: unknown }).balance
  return typeof balance === 'number' && Number.isFinite(balance) ? balance : null
}

export async function fetchChatanywhereQuota(options: Partial<ChatanywhereDeps> & { signal?: AbortSignal } = {}): Promise<{ quota: QuotaProvider }> {
  const deps = { ...defaults, ...options }
  try {
    const raw = await deps.readFile(deps.credentialPath, 64 * 1024)
    if (!raw) return { quota: empty('disconnected') }
    let session: Record<string, unknown>
    try { session = JSON.parse(raw) as Record<string, unknown> } catch { return { quota: empty('disconnected') } }
    if (!session || typeof session !== 'object' || Array.isArray(session)) return { quota: empty('disconnected') }
    const refreshToken = session.refreshToken
    if (typeof refreshToken !== 'string' || !refreshToken) return { quota: empty('disconnected') }

    const refreshed = await postJson(deps, REFRESH_URL, { refreshToken }, {}, options.signal)
    if (refreshed === 'transport') return { quota: empty('transientFailure') }
    if (refreshed.code !== 0) return { quota: repaste() }
    const next = mergeSession(session, refreshed.data)
    // A code-0 body without a usable token pair is not a license to reuse the
    // access token we just refused to trust.
    if (!next) return { quota: repaste() }
    try {
      deps.writeFileSync(deps.credentialPath, `${JSON.stringify(next)}\n`)
    } catch (error) {
      console.warn(`ChatAnywhere session not saved: ${sanitizeError(error)}`)
    }

    const overview = await postJson(
      deps,
      OVERVIEW_URL,
      {},
      { Authorization: `Bearer ${next.accessToken as string}` },
      options.signal,
    )
    if (overview === 'transport') return { quota: empty('transientFailure') }
    if (overview.code !== 0) return { quota: repaste() }
    const balance = balanceOf(overview.data)
    if (balance === null) return { quota: empty('transientFailure') }
    return { quota: empty('connected', [chatanywhereBalanceLine(balance)]) }
  } catch (error) {
    console.warn(`ChatAnywhere quota unavailable: ${sanitizeError(error)}`)
    return { quota: empty('transientFailure') }
  }
}
