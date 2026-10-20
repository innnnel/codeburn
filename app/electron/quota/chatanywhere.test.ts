import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CHATANYWHERE_REPASTE_FOOTER, chatanywhereBalanceLine, fetchChatanywhereQuota } from './chatanywhere'

const REFRESH_URL = 'https://chatanywhere.tech/api/console/auth/refresh'
const OVERVIEW_URL = 'https://chatanywhere.tech/api/console/overview'

const session = {
  user: { userId: 1, username: 'fixture-user', role: 'USER' },
  accessToken: 'access-old',
  refreshToken: 'refresh-old',
}

const refreshedUser = { userId: 1, username: 'fixture-user', role: 'USER' }

function refreshOk() {
  return json({
    code: 0,
    message: 'success',
    data: { accessToken: 'access-new', refreshToken: 'refresh-new', expiresIn: 1800, user: refreshedUser },
  })
}

function overviewOk(balance = 79.11352416) {
  return json({ code: 0, message: 'success', data: { balance, used: 1.5 } })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

let root: string
let credentialPath: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'codeburn-chatanywhere-'))
  credentialPath = path.join(root, 'chatanywhere.json')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

async function writeSession(value: unknown): Promise<void> {
  await writeFile(credentialPath, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 })
}

async function readSession(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(credentialPath, 'utf8')) as Record<string, unknown>
}

type Call = { url: string; body: unknown; authorization: string | null }

function routes(handlers: { refresh: () => Response; overview?: () => Response }): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetchMock = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string }).url ?? input)
    calls.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      authorization: new Headers(init?.headers).get('authorization'),
    })
    if (url === REFRESH_URL) return handlers.refresh()
    if (url === OVERVIEW_URL) return (handlers.overview ?? (() => json({ code: 1 })))()
    throw new Error(`unexpected url ${url}`)
  }) as unknown as typeof fetch
  return { fetch: fetchMock, calls }
}

describe('ChatAnywhere balance', () => {
  it('refreshes, merges the session, then reads overview balance with no progress bar', async () => {
    await writeSession(session)
    const { fetch, calls } = routes({ refresh: refreshOk, overview: () => overviewOk() })

    const result = await fetchChatanywhereQuota({ fetch, credentialPath })

    expect(calls.map(call => call.url)).toEqual([REFRESH_URL, OVERVIEW_URL])
    expect(calls[0]!.body).toEqual({ refreshToken: 'refresh-old' })
    expect(calls[1]!.authorization).toBe('Bearer access-new')
    expect(calls[1]!.body).toEqual({})
    expect(result.quota).toEqual({
      provider: 'chatanywhere',
      connection: 'connected',
      primary: null,
      details: [],
      planLabel: null,
      footerLines: [chatanywhereBalanceLine(79.11352416)],
    })
    expect(result.quota.footerLines).toEqual(['Balance · 79.11 CA'])
    expect(await readSession()).toEqual({
      ...session,
      accessToken: 'access-new',
      refreshToken: 'refresh-new',
      expiresIn: 1800,
      user: refreshedUser,
    })
  })

  it('persists the rotated refreshToken', async () => {
    await writeSession(session)
    const { fetch } = routes({ refresh: refreshOk, overview: () => overviewOk(10) })

    await fetchChatanywhereQuota({ fetch, credentialPath })

    expect((await readSession()).refreshToken).toBe('refresh-new')
    expect((await readSession()).refreshToken).not.toBe(session.refreshToken)
  })

  it('stops on refresh code !== 0 and does not call overview or keep the old access token', async () => {
    await writeSession(session)
    const { fetch, calls } = routes({ refresh: () => json({ code: 401, message: 'expired', data: null }) })

    const result = await fetchChatanywhereQuota({ fetch, credentialPath })

    expect(calls.map(call => call.url)).toEqual([REFRESH_URL])
    expect(calls.some(call => call.url.includes('usage_details'))).toBe(false)
    expect(result.quota).toMatchObject({
      connection: 'terminalFailure',
      connectable: true,
      primary: null,
      details: [],
      footerLines: [CHATANYWHERE_REPASTE_FOOTER],
    })
    expect(await readSession()).toEqual(session)
  })

  it('persists the rotated session when overview code !== 0 and does not fall back', async () => {
    await writeSession(session)
    const { fetch, calls } = routes({ refresh: refreshOk, overview: () => json({ code: 1001, message: 'rejected', data: {} }) })

    const result = await fetchChatanywhereQuota({ fetch, credentialPath })

    expect(calls.map(call => call.url)).toEqual([REFRESH_URL, OVERVIEW_URL])
    expect(calls[1]!.authorization).toBe('Bearer access-new')
    expect(calls.some(call => call.authorization === 'Bearer access-old')).toBe(false)
    expect(result.quota).toMatchObject({
      connection: 'terminalFailure',
      connectable: true,
      primary: null,
      details: [],
      footerLines: [CHATANYWHERE_REPASTE_FOOTER],
    })
    expect((await readSession()).refreshToken).toBe('refresh-new')
  })

  it('stays disconnected when the file is missing or has no refreshToken, and never fetches', async () => {
    const missing = vi.fn()
    const noFile = await fetchChatanywhereQuota({ fetch: missing as unknown as typeof fetch, credentialPath })
    expect(noFile.quota.connection).toBe('disconnected')
    expect(missing).not.toHaveBeenCalled()

    await writeSession({ accessToken: 'access-old' })
    const noRefresh = await fetchChatanywhereQuota({ fetch: missing as unknown as typeof fetch, credentialPath })
    expect(noRefresh.quota.connection).toBe('disconnected')
    expect(noRefresh.quota.footerLines).toEqual([])
    expect(missing).not.toHaveBeenCalled()
  })
})
