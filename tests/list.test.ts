import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { defaultConfig } from '../src/config'
import { buildCategoryExcludedMemeKeySet, buildListImages, buildMemeListEntries, buildMemeListSections, searchMemeInfos, sendMemeListForwardMessage, splitMemeListMessages } from '../src/command/register/meme-list'
import { MemeBackendClient } from '../src/backend'
import { resolveRandomMemeBucket } from '../src/command/random'
import { backendFixture, meme } from './helpers/backend'

describe('列表、分页与转发', () => {
  it('列表按类别去重排序，信息失败仍展示 key，搜索精确命中优先', () => {
    const entries = [{ key: 'hello', info: meme('hello', {}, ['你好']) }, { key: 'world', info: meme('world', {}, ['你好世界']) }, { key: 'failed' }]
    expect(buildMemeListSections(buildMemeListEntries(entries, true))).toEqual([
      { title: '仅需文字', aliases: ['你好（hello）', '你好世界（world）'] }, { title: '信息获取失败', aliases: ['failed'] }
    ])
    expect(searchMemeInfos(entries, '你好')).toEqual([{ alias: '你好' }, { alias: '你好世界' }])
  })
  it('文本按 UTF-8 3000 字节拆分，不破坏超长 Unicode 单词', () => {
    const aliases = ['文'.repeat(4000)]
    const chunks = splitMemeListMessages([{ title: '文字模板', aliases }])
    expect(chunks.every((chunk) => Buffer.byteLength(chunk) <= 3000)).toBe(true)
    expect(chunks.join('').replace('文字模板', '').replaceAll(/\s/g, '')).toBe(aliases[0])
  })
  it('分类排除和随机桶不是同一套规则', async () => {
    const multi = meme('multi', { min_images: 3, max_images: 3, min_texts: 0, max_texts: 0, default_texts: [] })
    const backend = await backendFixture([multi])
    try {
      const config = { ...defaultConfig, baseUrl: backend.url, excludeTwoImageOnlyMemes: true }
      const result = await buildCategoryExcludedMemeKeySet(new MemeBackendClient(config), ['multi'], config)
      expect(result.has('multi')).toBe(true)
      expect(resolveRandomMemeBucket(multi.params_type)).toBe('other')
    } finally { await backend.close() }
  })
  it('OneBot 业务失败尝试通用转发，再失败回退普通文本', async () => {
    const ctx = new Context()
    try {
      const request = vi.fn().mockResolvedValueOnce({ status: 'failed', retcode: 100 }).mockResolvedValueOnce({ status: 'ok', retcode: 0 })
      const session = { platform: 'onebot', guildId: '123', selfId: 'bot', bot: { internal: { _request: request } } }
      expect(await sendMemeListForwardMessage(session, [{ title: '标题', aliases: ['你好'] }], ctx.logger)).toBe(true)
      expect(request.mock.calls.map((call) => call[0])).toEqual(['send_group_forward_msg', 'send_forward_msg'])
      request.mockResolvedValue({ status: 'failed', retcode: 100 })
      expect(await sendMemeListForwardMessage(session, [{ title: '标题', aliases: ['你好'] }], ctx.logger)).toBe(false)
    } finally { await ctx.fiber.dispose() }
  })
  it('Takumi 实际渲染中韩文字，单图及多图均为 2400 像素宽', async () => {
    const ctx = new Context()
    try {
      const sections = [{ title: '文字与图片', aliases: Array.from({ length: 210 }, (_, index) => `模板${index} 안녕하세요`) }]
      const single = await buildListImages(sections, [], 'single', ctx.logger)
      const multiple = await buildListImages(sections, [], 'multiple', ctx.logger)
      expect(single).toHaveLength(1)
      expect(multiple?.length).toBeGreaterThan(1)
      for (const image of [...single ?? [], ...multiple ?? []]) {
        expect(image.subarray(1, 4).toString()).toBe('PNG')
        expect(image.readUInt32BE(16)).toBe(2400)
      }
      expect(multiple?.every((image) => image.readUInt32BE(20) <= 3200)).toBe(true)
    } finally { await ctx.fiber.dispose() }
  })
})
