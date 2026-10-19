import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchChatAnywhereQuota } from './chatanywhere'

const NOW = Date.parse('2026-10-19T07:30:00.000Z')
const dirs: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function configPath(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'chatanywhere-quota-'))
  dirs.push(dir)
  return path.join(dir, 'chatanywhere.json')
}

function writeConfig(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
}

function row(time: string, cost: number, totalTokens: number, count: number) {
  return { time, promptTokens: 1, completionTokens: 1, totalTokens, count, cost }
}

const ok = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })

describe('ChatAnywhere usage totals', () => {
  it('sums Shanghai calendar windows across two models and keeps a 0.01 cost', async () => {
    const file = configPath()
    writeConfig(file, { apiKey: 'sk-test-key', models: ['alpha-model', 'beta-model'] })
    const byModel: Record<string, unknown[]> = {
      'alpha-model': [
        row('2026-10-18 23:00:00', 0.01, 10, 1),
        row('2026-10-19 00:00:00', 0.02, 20, 2),
        row('2026-09-19 23:00:00', 5, 500, 50),
      ],
      'beta-model': [
        row('2026-10-19 00:00:00', 0.03, 30, 3),
        row('2026-09-20 00:00:00', 0.04, 40, 4),
      ],
    }
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string }
      return ok(byModel[body.model] ?? [])
    })

    const result = await fetchChatAnywhereQuota({ fetch: fetchMock, configPath: file, now: () => NOW })

    const monthStart = Date.parse('2026-09-20T00:00:00+08:00')
    const expectedHours = Math.ceil((NOW - monthStart) / 3_600_000)
    expect(expectedHours).toBe(712)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const bodies = fetchMock.mock.calls.map(call => {
      const init = (call as unknown as [string, RequestInit])[1]
      return JSON.parse(String(init.body)) as { model: string; hours: number }
    })
    expect(bodies).toEqual([
      { model: 'alpha-model', hours: expectedHours },
      { model: 'beta-model', hours: expectedHours },
    ])
    expect([24, 168, 720]).not.toContain(expectedHours)
    for (const call of fetchMock.mock.calls) {
      const headers = (call as unknown as [string, RequestInit])[1].headers as Record<string, string>
      expect(headers.Authorization).toBe('sk-test-key')
      expect(headers['Content-Type']).toBe('application/json')
    }
    expect(result.quota).toMatchObject({
      provider: 'chatanywhere',
      connection: 'connected',
      primary: null,
      details: [],
      planLabel: null,
    })
    // 23:00 yesterday is outside 当天. 00:00 today is inside every window.
    // 23:00 on the day before the 30-day start is outside all three.
    // 00:00 on the 30-day start is inside only 30 天.
    expect(result.quota.footerLines).toEqual([
      '当天 · 0.05 CA · 50 tokens · 5 次',
      '7 天 · 0.06 CA · 60 tokens · 6 次',
      '30 天 · 0.10 CA · 100 tokens · 10 次',
    ])
  })

  it('does not truncate a cost of 0.01', async () => {
    const file = configPath()
    writeConfig(file, { apiKey: 'sk-test-key', models: ['solo'] })
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => ok([row('2026-10-19 01:00:00', 0.01, 52, 2)]))

    const result = await fetchChatAnywhereQuota({ fetch: fetchMock, configPath: file, now: () => NOW })

    expect(result.quota.footerLines).toEqual([
      '当天 · 0.01 CA · 52 tokens · 2 次',
      '7 天 · 0.01 CA · 52 tokens · 2 次',
      '30 天 · 0.01 CA · 52 tokens · 2 次',
    ])
  })

  it('fails the whole fetch when one model request fails', async () => {
    const file = configPath()
    writeConfig(file, { apiKey: 'sk-test-key', models: ['alpha-model', 'beta-model'] })
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string }
      if (body.model === 'beta-model') return new Response('nope', { status: 500 })
      return ok([row('2026-10-19 01:00:00', 9.99, 1000, 9)])
    })

    const result = await fetchChatAnywhereQuota({ fetch: fetchMock, configPath: file, now: () => NOW })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.quota.connection).toBe('transientFailure')
    expect(result.quota.footerLines).toEqual([])
    expect(result.quota.primary).toBeNull()
    expect(result.quota.details).toEqual([])
    expect(result.retryAfterSeconds).toBeUndefined()
  })

  it('maps 429 onto the quota rate-limit state and does not retry', async () => {
    const file = configPath()
    writeConfig(file, { apiKey: 'sk-test-key', models: ['alpha-model', 'beta-model'] })
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => new Response('', { status: 429, headers: { 'Retry-After': '12' } }))

    const result = await fetchChatAnywhereQuota({ fetch: fetchMock, configPath: file, now: () => NOW })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.quota.connection).toBe('transientFailure')
    expect(result.quota.rateLimited).toBe(true)
    expect(result.quota.footerLines).toEqual([])
    expect(result.retryAfterSeconds).toBe(60)
  })

  it('queries the model strings stored in the config file', async () => {
    const file = configPath()
    writeConfig(file, { apiKey: ' pasted-key ', models: ['from-file-a', 'from-file-b'], note: 'keep' })
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => ok([]))

    const result = await fetchChatAnywhereQuota({ fetch: fetchMock, configPath: file, now: () => NOW })

    const models = fetchMock.mock.calls.map(call => {
      const init = (call as unknown as [string, RequestInit])[1]
      return (JSON.parse(String(init.body)) as { model: string }).model
    })
    expect(models).toEqual(['from-file-a', 'from-file-b'])
    expect(models).not.toContain('gpt-6.1-sol')
    expect(((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>).Authorization).toBe('pasted-key')
    expect(result.quota.footerLines).toEqual([
      '当天 · 0.00 CA · 0 tokens · 0 次',
      '7 天 · 0.00 CA · 0 tokens · 0 次',
      '30 天 · 0.00 CA · 0 tokens · 0 次',
    ])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ note: 'keep', models: ['from-file-a', 'from-file-b'] })
  })

  it('seeds an empty key and does not query when the file is missing', async () => {
    const file = configPath()
    const fetchMock = vi.fn()

    const result = await fetchChatAnywhereQuota({ fetch: fetchMock, configPath: file, now: () => NOW })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.quota.connection).toBe('disconnected')
    const written = JSON.parse(readFileSync(file, 'utf8')) as { apiKey: string; models: string[] }
    expect(written.apiKey).toBe('')
    expect(written.models).toEqual([
      'gpt-6.1-sol',
      'gpt-6-luna',
      'gpt-image-2.5-flare',
      'gpt-image-2.5-sunburst',
      'gpt-6-astra',
      'claude-opus-5-5',
      'claude-fable-5-1',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
    ])
  })

  it('does not query or overwrite a file with an empty key or an empty model list', async () => {
    const file = configPath()
    writeConfig(file, { apiKey: '', models: ['gpt-6.1-sol'] })
    const fetchMock = vi.fn()

    const missingKey = await fetchChatAnywhereQuota({ fetch: fetchMock, configPath: file, now: () => NOW })
    expect(missingKey.quota.connection).toBe('disconnected')

    writeConfig(file, { apiKey: 'sk-test-key', models: [] })
    const missingModels = await fetchChatAnywhereQuota({ fetch: fetchMock, configPath: file, now: () => NOW })
    expect(missingModels.quota.connection).toBe('disconnected')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ apiKey: 'sk-test-key', models: [] })
  })
})
