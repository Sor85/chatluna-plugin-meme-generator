import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActionInput } from '@chatluna/chat'
import { host } from './helpers/host'
import { meme, validPng } from './helpers/backend'
import { describeTemplate } from '../src/prompt-templates'

type PromptEnvironment = Parameters<Exclude<NonNullable<ActionInput['prompt']>, string>>[0]
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
async function setup(config: Parameters<typeof host>[0] = {}) {
  const value = await host({ enableMemeXmlTool: true, ...config })
  cleanup.push(value.close)
  return value
}
function prompt(app: Awaited<ReturnType<typeof setup>>, env: Partial<PromptEnvironment> = { guildId: 'group' }) {
  const value = app.actions.get('meme')?.prompt
  if (typeof value !== 'function') throw new Error('meme 动作没有动态提示')
  return value({ now: 0, ...env })
}

/** The plugin only uses addEntry/state/action, so a recorder stands in for the WebUI server. */
function webui(app: Awaited<ReturnType<typeof setup>>) {
  const states = new Map<string, { get(params?: unknown): unknown }>()
  const actions = new Map<string, (input: unknown) => unknown>()
  app.ctx.provide('chatluna_webui', {
    addEntry: () => () => {},
    state(key: string, options: { get(): unknown }) { states.set(key, options); return () => states.delete(key) },
    action(name: string, _options: unknown, fn: (input: unknown) => unknown) { actions.set(name, fn); return () => actions.delete(name) }
  })
  return { states, actions }
}

describe('注入模板', () => {
  it('未选择模板时不注册动态提示', async () => {
    const app = await setup()
    expect(app.actions.get('meme')?.prompt).toBeUndefined()
  })

  it('选中模板连同名称与图文数量写入动作提示，读取失败的 key 原样列出', async () => {
    const app = await setup({ promptMemeKeys: ['hello', 'missing'] })
    await vi.waitFor(() => expect(prompt(app)).toContain('- hello (你好): 1-2 texts'))
    expect(prompt(app)).toContain('without meme_search')
    expect(prompt(app).split('\n')).toContain('- missing')
    expect(app.backend.generated).toHaveLength(0)
  })

  it('全局、分群与类别排除同样作用于注入模板', async () => {
    const app = await setup({
      promptMemeKeys: ['hello', 'world'], excludedMemeKeys: ['WORLD'],
      groupExcludedMemeKeys: [{ groupId: 'group', excludedMemeKeys: ['hello'] }]
    })
    await vi.waitFor(() => expect(prompt(app, { guildId: 'other' })).toContain('- hello'))
    expect(prompt(app, { guildId: 'other' })).not.toContain('world')
    expect(prompt(app, { guildId: 'group' })).toBe('')
    expect(prompt(app, { guildId: 'group', isDirect: true })).toContain('- hello')
    const category = await setup({ promptMemeKeys: ['hello'], excludeTextOnlyMemes: true })
    await vi.waitFor(() => expect(prompt(category)).toBe(''))
  })

  it('图文数量按单复数与范围描述', () => {
    expect(describeTemplate('hug', meme('hug', { min_images: 2, max_images: 2, min_texts: 0, max_texts: 0 }, ['抱', '抱抱'])))
      .toBe('- hug (抱, 抱抱): 2 images')
    expect(describeTemplate('pat', meme('pat', { min_images: 0, max_images: 1, min_texts: 1, max_texts: 1 })))
      .toBe('- pat: 0-1 image, 1 text')
    expect(describeTemplate('none', meme('none', { min_texts: 0, max_texts: 0 }))).toBe('- none: no inputs')
  })
})

describe('设置页模板选择器数据', () => {
  it('推送全部模板的名称、分类与检索文本', async () => {
    const app = await setup()
    app.backend.templates.set('hug', meme('hug', { min_images: 2, max_images: 2, min_texts: 0, max_texts: 0 }, ['抱']))
    const { states } = webui(app)
    await vi.waitFor(() => expect(states.has('meme-generator.templates')).toBe(true))
    const catalog = await states.get('meme-generator.templates')?.get()
    expect(catalog).toEqual({
      failed: 0,
      templates: [
        { key: 'hello', name: '你好', detail: 'hello 你好', category: 'text-only' },
        { key: 'hug', name: '抱', detail: 'hug 抱', category: 'two-image-only' },
        { key: 'world', name: '世界', detail: 'world 世界', category: 'text-only' }
      ]
    })
  })

  it('预览缩成 WebP 并缓存，失败不缓存', async () => {
    const app = await setup()
    app.backend.setPreview(validPng())
    const { actions } = webui(app)
    await vi.waitFor(() => expect(actions.has('meme-generator.preview')).toBe(true))
    const preview = actions.get('meme-generator.preview')
    if (!preview) throw new Error('缺少预览动作')
    const first = preview({ key: 'hello' })
    const thumbnail = await first
    expect(thumbnail).toMatch(/^data:image\/webp;base64,/)
    // A thumbnail that lost its image is a blank WebP; render one to compare against.
    const blank = await app.ctx.takumi.render({ type: 'container', style: { width: 96, height: 96 } }, { width: 96, height: 96, format: 'webp', quality: 80 })
    expect(Buffer.from(thumbnail.split(',')[1]!, 'base64').equals(blank)).toBe(false)
    expect(preview({ key: 'hello' })).toBe(first)
    const missing = preview({ key: 'missing' })
    await expect(missing).rejects.toThrow()
    expect(preview({ key: 'missing' })).not.toBe(missing)
  })
})
