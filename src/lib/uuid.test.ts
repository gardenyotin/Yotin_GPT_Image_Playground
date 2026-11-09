import { afterEach, expect, it, vi } from 'vitest'
import { createUuid } from './uuid'

afterEach(() => vi.unstubAllGlobals())

it('普通 HTTP 页面没有 randomUUID 时仍生成不同的 UUID v4', () => {
  vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
  const ids = Array.from({ length: 100 }, () => createUuid())
  expect(new Set(ids).size).toBe(100)
  expect(ids.every((id) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id))).toBe(true)
})
