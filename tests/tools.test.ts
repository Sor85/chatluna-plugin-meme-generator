import { afterEach, describe, expect, it } from 'vitest'
import { ChatMessage, fileRefTableOf, type ChatFileBlock } from '@chatluna/message'
import { host } from './helpers/host'
import { PNG, meme } from './helpers/backend'
import { normalizeValues } from '../src/tools'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
async function setup(config: Parameters<typeof host>[0] = {}) { const value = await host({ enableMemeXmlTool: true, ...config }); cleanup.push(value.close); return value }

describe('v2 原生动作与工具', () => {
  it('默认不开启；启用后 XML 映射同一个原生工具', async () => {
    const app = await setup({ enableMemeXmlTool: false })
    expect(app.ctx.tools.list().some((tool) => tool.name === 'meme_generate')).toBe(false)
    const enabled = await setup()
    expect(enabled.actions.get('meme')?.tool).toBe('meme_generate')
    expect(enabled.ctx.tools.list().some((tool) => tool.name === 'meme_generate')).toBe(true)
  })

  it('真正向平台发图，并将结果投影为图片块而非 base64 文本', async () => {
    const app = await setup()
    const result = await app.ctx.tools.execute({ name: 'meme_generate', routeId: 'test-route', args: { key: '你好', text: '工具文字' } })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(app.sent).toHaveLength(1)
    expect(app.sent[0]).toContain('<img')
    expect(app.backend.generated[0].texts).toEqual(['工具文字'])
    expect(result.content.find((block) => block.type === 'file')).toMatchObject({ mediaType: 'image/png', data: { type: 'data', data: PNG.toString('base64') } })
    expect(result.content.filter((block) => block.type === 'text').map((block) => block.text).join('')).not.toContain(PNG.toString('base64'))
  })

  it('支持按顺序执行批量动作与复数字段，不拆分数组内的管道', async () => {
    const app = await setup()
    const result = await app.ctx.tools.execute({ name: 'meme_generate', routeId: 'test-route', args: { actions: [
      { key: 'hello', texts: ['a|b', 'a|b'] }, { key: 'world', text: 'c|d' }
    ] } })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(app.backend.generated.map((item) => [item.key, item.texts])).toEqual([['hello', ['a|b']], ['world', ['c', 'd']]])
    expect(app.sent).toHaveLength(2)
    expect(normalizeValues('a| a |b')).toEqual(['a', 'b'])
  })

  it('工具不继承触发消息的图片或文字', async () => {
    const app = await setup({ emptyTextAutoFillRules: [{ source: 'template-default', enabled: true, weight: 100 }], enableQuotedTextTrigger: true })
    app.setCurrent(app.session('不是参数 <img src="http://127.0.0.1/private.png"/>'))
    const result = await app.ctx.tools.execute({ name: 'meme_generate', routeId: 'test-route', args: { key: 'hello' } })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(app.backend.generated[0].texts).toEqual(['默认文字'])
    expect(app.backend.generated[0].images).toEqual([])
  })

  it('仅解析调用会话的图片 ref，取原图而非 preview', async () => {
    const app = await setup()
    app.backend.templates.set('portrait', meme('portrait', { min_images: 1, max_images: 1, min_texts: 0, max_texts: 0, default_texts: [] }))
    const block: ChatFileBlock = { type: 'file', mediaType: 'image/png', data: { type: 'data', data: PNG.toString('base64') }, preview: { type: 'data', data: 'AA==' } }
    const messages = [ChatMessage.user([block])]
    const ref = fileRefTableOf(messages).refOf(block)
    const result = await app.ctx.tools.execute({ name: 'meme_generate', routeId: 'test-route', agent: { session: { messages: () => messages } }, args: { key: 'portrait', image: ref } })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    const uploaded = app.backend.generated[0].images[0]
    if (typeof uploaded === 'string') throw new Error('Expected file')
    expect(Buffer.from(await uploaded.arrayBuffer())).toEqual(PNG)
    const missing = await app.ctx.tools.execute({ name: 'meme_generate', routeId: 'test-route', args: { key: 'portrait', image: ref } })
    expect(missing.ok).toBe(false)
    expect(app.sent).toHaveLength(1)
  })

  it('分群排除、无上下文和后端失败不会伪造发送成功', async () => {
    const app = await setup({ groupExcludedMemeKeys: [{ groupId: 'group', excludedMemeKeys: ['hello'] }] })
    const excluded = await app.ctx.tools.execute({ name: 'meme_generate', routeId: 'test-route', args: { key: 'hello' } })
    expect(excluded.ok).toBe(false)
    const unbound = await app.ctx.tools.execute({ name: 'meme_generate', args: { key: 'world' } })
    expect(unbound.ok).toBe(false)
    app.backend.failures.set('world', 541)
    const failed = await app.ctx.tools.execute({ name: 'meme_generate', routeId: 'test-route', args: { key: 'world' } })
    expect(failed.ok).toBe(false)
    expect(app.sent).toHaveLength(0)
  })

  it('插件卸载时注销原生工具', async () => {
    const app = await setup()
    await app.fiber.dispose()
    expect(app.ctx.tools.list().some((tool) => tool.name === 'meme_generate')).toBe(false)
  })
})
