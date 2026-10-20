import { afterEach, describe, expect, it } from 'vitest'

import { setCurrentLocale } from '../i18n'
import { localizeQuotaFooter } from './providers'

afterEach(() => setCurrentLocale('en'))

describe('ChatAnywhere quota footer', () => {
  it('keeps hundredths and follows the catalogs, including 余额', () => {
    setCurrentLocale('en')
    expect(localizeQuotaFooter('chatanywhere', 'Balance · 79.11 CA')).toBe('Balance · 79.11 CA')
    setCurrentLocale('zh-CN')
    expect(localizeQuotaFooter('chatanywhere', 'Balance · 79.11 CA')).toBe('余额 · 79.11 CA')
    expect(localizeQuotaFooter('chatanywhere', 'Paste chatanywhere-session into ~/.config/codeburn/chatanywhere.json again, then refresh.'))
      .toBe('请重新将 chatanywhere-session 粘贴到 ~/.config/codeburn/chatanywhere.json，然后刷新。')
    expect(localizeQuotaFooter('kimi', 'Login expired. Run the Kimi CLI once, then refresh.')).toBe('Login expired. Run the Kimi CLI once, then refresh.')
  })
})
