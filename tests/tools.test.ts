import { afterEach, describe, expect, it } from 'vitest'
import { ChatMessage, fileRefTableOf, type ChatFileBlock } from '@chatluna/message'
import type { ActionContext } from '@chatluna/chat'
import { host } from './helpers/host'
import { PNG, meme } from './helpers/backend'
import { normalizeValues } from '../src/actions'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
async function setup(config: Parameters<typeof host>[0] = {}) { const value = await host({ enableMemeXmlTool: true, ...config }); cleanup.push(value.close); return value }
async function runAction(app: Awaited<ReturnType<typeof setup>>, attrs: Record<string, unknown>, context: Partial<ActionContext> = {}) {
  const action = app.actions.get('meme')
  if (!action?.run) throw new Error('未注册独立 meme 动作')
  await action.run(attrs, { attrs, session: app.session(), ...context })
}

describe('只读查询工具与独立 meme 动作', () => {
  it('默认不开启；开启后仅公开查询工具，动作不再映射生成工具', async () => {
    const disabled = await setup({ enableMemeXmlTool: false })
    expect(disabled.ctx.tools.list().some((tool) => tool.name === 'meme_search')).toBe(false)
    expect(disabled.actions.has('meme')).toBe(false)
    const app = await setup()
    expect(app.ctx.tools.list().some((tool) => tool.name === 'meme_generate')).toBe(false)
    const search = app.ctx.tools.list().find((tool) => tool.name === 'meme_search')
    expect(search?.traits?.effect).toBe('read')
    expect(search?.description).toContain('never generates or sends')
    expect(app.actions.get('meme')?.tool).toBeUndefined()
    expect(app.actions.get('meme')?.run).toBeTypeOf('function')
    expect(app.actions.get('meme')?.description).toContain('meme_search')
  })

  it('接受单个或多个查询词，仅向模型返回结构化模板资料', async () => {
    const app = await setup()
    for (const keywords of ['你好', ['你好', '世界']]) {
      const result = await app.ctx.tools.execute({ name: 'meme_search', routeId: 'test-route', args: { keywords } })
      expect(result.ok, JSON.stringify(result)).toBe(true)
      if (!result.ok) throw new Error(result.error.message)
      expect(result.value).toMatchObject({ failed_templates: 0, results: expect.arrayContaining([expect.objectContaining({ key: 'hello', images: { min: 0, max: 0 }, texts: { min: 1, max: 2, defaults: ['默认文字'] } })]) })
      expect(result.content.some((block) => block.type === 'file')).toBe(false)
    }
    expect(app.sent).toHaveLength(0)
    expect(app.backend.generated).toHaveLength(0)
  })

  it('只读搜索遵守全局、分群及类别排除', async () => {
    const app = await setup({ groupExcludedMemeKeys: [{ groupId: 'group', excludedMemeKeys: ['hello'] }], excludedMemeKeys: ['world'] })
    const blocked = await app.ctx.tools.execute({ name: 'meme_search', routeId: 'test-route', args: { keywords: ['hello', 'world'] } })
    expect(blocked.ok && blocked.value).toMatchObject({ results: [] })
    app.setCurrent(app.session('', 'allowed'))
    const other = await app.ctx.tools.execute({ name: 'meme_search', routeId: 'test-route', args: { keywords: ['hello', 'world'] } })
    expect(other.ok && other.value).toMatchObject({ results: [{ key: 'hello' }] })
    const category = await setup({ excludeTextOnlyMemes: true })
    const filtered = await category.ctx.tools.execute({ name: 'meme_search', routeId: 'test-route', args: { keywords: ['hello', 'world'] } })
    expect(filtered.ok && filtered.value).toMatchObject({ results: [] })
  })

  it('搜索拒绝无平台上下文、空词和过多查询，不触发生成', async () => {
    const app = await setup()
    const unbound = await app.ctx.tools.execute({ name: 'meme_search', args: { keywords: 'hello' } })
    expect(unbound.ok).toBe(false)
    for (const keywords of [[], [' '], Array.from({ length: 9 }, () => 'hello')]) {
      const result = await app.ctx.tools.execute({ name: 'meme_search', routeId: 'test-route', args: { keywords } })
      expect(result.ok).toBe(false)
    }
    expect(app.backend.generated).toHaveLength(0)
    expect(app.sent).toHaveLength(0)
  })

  it('独立动作真实发送一次，多个动作按顺序执行', async () => {
    const app = await setup()
    await Promise.all([
      runAction(app, { key: '你好', texts: ['a|b', 'a|b'] }),
      runAction(app, { key: 'world', text: 'c|d' })
    ])
    expect(app.backend.generated.map((item) => [item.key, item.texts])).toEqual([['hello', ['a|b']], ['world', ['c', 'd']]])
    expect(app.sent).toHaveLength(2)
    expect(app.sent.every((message) => message.includes('<img'))).toBe(true)
    expect(normalizeValues('a| a |b')).toEqual(['a', 'b'])
  })

  it('动作不继承触发消息的图片或文字', async () => {
    const app = await setup({ emptyTextAutoFillRules: [{ source: 'template-default', enabled: true, weight: 100 }], enableQuotedTextTrigger: true })
    await runAction(app, { key: 'hello' }, { session: app.session('不是参数 <img src="http://127.0.0.1/private.png"/>') })
    expect(app.backend.generated[0].texts).toEqual(['默认文字'])
    expect(app.backend.generated[0].images).toEqual([])
  })

  it('只从宿主动作上下文对应的活动会话解析图片 ref，取原图', async () => {
    const app = await setup()
    app.backend.templates.set('portrait', meme('portrait', { min_images: 1, max_images: 1, min_texts: 0, max_texts: 0, default_texts: [] }))
    const block: ChatFileBlock = { type: 'file', mediaType: 'image/png', data: { type: 'data', data: PNG.toString('base64') }, preview: { type: 'data', data: 'AA==' } }
    const messages = [ChatMessage.user([block])]
    const ref = fileRefTableOf(messages).refOf(block)
    app.ctx.provide('agents', { get: (id: string) => id === 'current-agent' ? { signal: new AbortController().signal, session: { messages: () => messages } } : undefined })
    await runAction(app, { key: 'portrait', image: ref }, { sessionId: 'current-agent' })
    const uploaded = app.backend.generated[0].images[0]
    if (typeof uploaded === 'string') throw new Error('Expected file')
    expect(Buffer.from(await uploaded.arrayBuffer())).toEqual(PNG)
    await expect(runAction(app, { key: 'portrait', image: ref, sessionId: 'current-agent' }, { sessionId: 'other-agent' })).rejects.toThrow('当前会话')
    expect(app.sent).toHaveLength(1)
  })

  it('动作校验原始 XML 参数，排除或后端失败时抛错且不发送', async () => {
    const app = await setup({ groupExcludedMemeKeys: [{ groupId: 'group', excludedMemeKeys: ['hello'] }] })
    await expect(runAction(app, {})).rejects.toThrow('参数无效')
    await expect(runAction(app, { key: 123 })).rejects.toThrow('参数无效')
    await expect(runAction(app, { key: 'hello' })).rejects.toThrow('排除')
    await expect(runAction(app, { key: 'world' }, { session: undefined })).rejects.toThrow('平台会话')
    app.backend.failures.set('world', 541)
    await expect(runAction(app, { key: 'world' })).rejects.toThrow('模板生成失败')
    expect(app.sent).toHaveLength(0)
    app.backend.failures.delete('world')
    await runAction(app, { key: 'world' })
    expect(app.sent).toHaveLength(1)
  })

  it('活动 agent 取消及插件卸载会阻止动作发送，搜索工具随卸载注销', async () => {
    const app = await setup()
    const controller = new AbortController()
    app.ctx.provide('agents', { get: () => ({ signal: controller.signal, session: { messages: () => [] } }) })
    controller.abort(new Error('停止动作'))
    await expect(runAction(app, { key: 'hello' }, { sessionId: 'agent' })).rejects.toThrow('停止动作')
    await app.fiber.dispose()
    expect(app.ctx.tools.list().some((tool) => tool.name === 'meme_search')).toBe(false)
    await expect(runAction(app, { key: 'hello' })).rejects.toThrow()
    expect(app.backend.generated).toHaveLength(0)
    expect(app.sent).toHaveLength(0)
  })
})
