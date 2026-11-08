import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultConfig } from '../src/config'
import { MemeBackendClient } from '../src/backend'
import { MemeSearchIndex } from '../src/search'
import { backendFixture, meme } from './helpers/backend'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0)) await close() })
const signal = () => new AbortController().signal
const allowed = () => true
async function setup() {
  const backend = await backendFixture([
    { ...meme('hug', { min_images: 2, max_images: 2, min_texts: 0, max_texts: 0, default_texts: [] }, ['抱抱']), tags: ['拥抱'], shortcuts: [{ key: 'embrace', humanized: '贴贴' }] },
    { ...meme('taunt', {}, ['嘲笑']), tags: ['调侃'] }
  ])
  cleanup.push(backend.close)
  const config = { ...defaultConfig, baseUrl: backend.url, memeSearchCacheMinutes: 1 }
  const client = new MemeBackendClient(config)
  return { backend, client, index: new MemeSearchIndex(config, client) }
}

describe('模板关键词检索', () => {
  it('按 key、别名、标签及默认文案查询，只返回模板资料', async () => {
    const app = await setup()
    for (const keyword of ['hug', '抱抱', '拥抱', 'embrace', '贴贴', 'ＨＵＧ']) {
      const result = await app.index.search({ keywords: [keyword], limit: 5 }, allowed, signal())
      expect(result.failed_templates).toBe(0)
      expect(result.results[0]).toMatchObject({ key: 'hug', images: { min: 2, max: 2 }, texts: { min: 0, max: 0, defaults: [] } })
      expect(result).not.toHaveProperty('mode')
      expect(result).not.toHaveProperty('fallback_reason')
    }
    expect((await app.index.search({ keywords: ['默认文字'], limit: 5 }, allowed, signal())).results[0].key).toBe('taunt')
    expect(app.backend.generated).toHaveLength(0)
  })

  it('多个关键词按任一匹配合并去重，精确匹配优先并遵守 limit', async () => {
    const app = await setup()
    const result = await app.index.search({ keywords: ['抱', '调侃', 'hug', 'HUG'], limit: 2 }, allowed, signal())
    expect(result.results.map((item) => item.key)).toEqual(['hug', 'taunt'])
    expect((await app.index.search({ keywords: ['hug', 'taunt'], limit: 1 }, allowed, signal())).results).toHaveLength(1)
    expect((await app.index.search({ keywords: ['完全不存在'], limit: 5 }, allowed, signal())).results).toEqual([])
  })

  it('按当前请求过滤候选，缓存不会泄漏其他群可用模板', async () => {
    const app = await setup()
    const input = { keywords: ['hug', 'taunt'], limit: 5 }
    expect((await app.index.search(input, allowed, signal())).results).toHaveLength(2)
    const result = await app.index.search(input, (info) => info.key !== 'hug', signal())
    expect(result.results.map((item) => item.key)).toEqual(['taunt'])
  })

  it('复用元数据缓存，过期后更新内容并移除失效模板', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const app = await setup()
    const keys = vi.spyOn(app.client, 'getKeys')
    await app.index.search({ keywords: ['hug'], limit: 5 }, allowed, signal())
    await app.index.search({ keywords: ['taunt'], limit: 5 }, allowed, signal())
    expect(keys).toHaveBeenCalledTimes(1)
    app.backend.templates.delete('taunt')
    app.backend.templates.set('hug', meme('hug', {}, ['安慰']))
    now += 61000
    const result = await app.index.search({ keywords: ['安慰', 'taunt'], limit: 5 }, allowed, signal())
    expect(keys).toHaveBeenCalledTimes(2)
    expect(result.results.map((item) => item.key)).toEqual(['hug'])
    expect(result.results[0].keywords).toEqual(['安慰'])
  })

  it('部分模板信息失败明确返回不完整状态，全部失败则报错', async () => {
    const app = await setup()
    const get = app.client.getInfo.bind(app.client)
    vi.spyOn(app.client, 'getInfo').mockImplementation((key, signal) => key === 'taunt' ? Promise.reject(new Error('后端异常')) : get(key, signal))
    const result = await app.index.search({ keywords: ['hug'], limit: 5 }, allowed, signal())
    expect(result.failed_templates).toBe(1)
    expect(result.results[0].key).toBe('hug')
    const empty = await setup()
    vi.spyOn(empty.client, 'getInfo').mockRejectedValue(new Error('信息不可用'))
    await expect(empty.index.search({ keywords: ['hug'], limit: 5 }, allowed, signal())).rejects.toThrow('索引未建立')
  })

  it('索引读取传递取消信号，取消后下一次查询仍可用', async () => {
    const app = await setup()
    const controller = new AbortController()
    const requests: AbortSignal[] = []
    let entered = () => {}
    const started = new Promise<void>((resolve) => { entered = resolve })
    vi.spyOn(app.client, 'getKeys').mockImplementationOnce((requestSignal) => {
      if (!requestSignal) throw new Error('缺少取消信号')
      requests.push(requestSignal)
      entered()
      return new Promise((_, reject) => requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true }))
    })
    const pending = app.index.search({ keywords: ['hug'], limit: 5 }, allowed, controller.signal)
    const rejected = expect(pending).rejects.toThrow('取消索引')
    await started
    controller.abort(new Error('取消索引'))
    await rejected
    expect(requests[0]).toBe(controller.signal)
    expect((await app.index.search({ keywords: ['hug'], limit: 5 }, allowed, signal())).results[0].key).toBe('hug')
  })

  it('已取消的调用不访问后端', async () => {
    const app = await setup()
    const get = vi.spyOn(app.client, 'getKeys')
    const controller = new AbortController()
    controller.abort(new Error('已取消'))
    await expect(app.index.search({ keywords: ['hug'], limit: 5 }, allowed, controller.signal)).rejects.toThrow('已取消')
    expect(get).not.toHaveBeenCalled()
  })

  it('空模板库正常返回空结果', async () => {
    const app = await setup()
    app.backend.templates.clear()
    expect(await app.index.search({ keywords: ['hug'], limit: 5 }, allowed, signal())).toEqual({ failed_templates: 0, results: [] })
  })

  it('拒绝空查询、过多关键词及越界限制', async () => {
    const app = await setup()
    for (const keywords of [[], [' '], ['x'.repeat(201)], Array.from({ length: 9 }, (_, i) => String(i))]) {
      await expect(app.index.search({ keywords, limit: 5 }, allowed, signal())).rejects.toThrow()
    }
    for (const limit of [0, 11, 1.5]) {
      await expect(app.index.search({ keywords: ['hug'], limit }, allowed, signal())).rejects.toThrow()
    }
  })
})
