import { afterEach, describe, expect, it, vi } from 'vitest'
import { host } from './helpers/host'
import { meme } from './helpers/backend'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0)) await close() })
async function setup(config: Parameters<typeof host>[0] = {}) { const value = await host(config); cleanup.push(value.close); return value }

describe('v2 真实平台命令桥', () => {
  it('注册六个命令，别名生成、信息、预览、列表和搜索保持可用', async () => {
    const app = await setup()
    for (const name of ['meme', 'meme.list', 'meme.info', 'meme.preview', 'meme.search', 'meme.random']) expect(app.ctx.$commander.get(name)).toBeDefined()
    expect(await app.execute('meme 你好 第一段 第二段')).toContain('<img')
    expect(app.backend.generated[0].texts).toEqual(['第一段', '第二段'])
    expect(await app.execute('meme.info 你好')).toContain('key: hello')
    expect(await app.execute('meme.preview hello')).toContain('<img')
    expect(await app.execute('meme.search 你好')).toContain('1. 你好')
    await app.execute('meme.list')
    expect(app.sent.join('')).toContain('仅需文字')
    expect(app.sent.join('')).toContain('世界')
  })

  it('关闭主生成命令不移除子命令', async () => {
    const app = await setup({ enableMemeCommandTrigger: false })
    expect(await app.execute('meme.info hello')).toContain('key: hello')
    await app.execute('meme hello')
    expect(app.backend.generated).toHaveLength(0)
  })

  it('全局和分群排除在命令入口一致生效', async () => {
    const app = await setup({ excludedMemeKeys: [' WORLD '], groupExcludedMemeKeys: [{ groupId: 'blocked', excludedMemeKeys: ['HELLO'] }] })
    expect(await app.execute('meme.info world')).toContain('已被排除')
    expect(await app.execute('meme.preview hello', 'blocked')).toContain('已被排除')
    expect(await app.execute('meme hello', 'blocked')).toContain('已被排除')
    expect(await app.execute('meme hello', 'allowed')).toContain('<img')
    expect(app.backend.generated).toHaveLength(1)
  })

  it('随机调用跨会话排队去重，成功后才记录', async () => {
    const app = await setup({ enableRandomDedupeWithinHours: true })
    const output = await Promise.all([app.execute('meme.random', 'one'), app.execute('meme.random', 'two')])
    expect(output.every((text) => text.includes('key：') && text.includes('<img'))).toBe(true)
    expect(new Set(app.backend.generated.map((item) => item.key)).size).toBe(2)
    await app.execute('meme.random')
    expect(app.backend.generated).toHaveLength(3)
  })

  it('随机模板失败后继续尝试其他候选，禁用桶不兜底抽取', async () => {
    const app = await setup()
    app.backend.failures.set('hello', 541)
    vi.spyOn(Math, 'random').mockReturnValue(0)
    expect(await app.execute('meme.random')).toContain('world')
    expect(app.backend.generated.map((item) => item.key)).toEqual(['hello', 'world'])
    const disabled = await setup({ randomMemeBucketWeightRules: [] })
    await disabled.execute('meme.random')
    expect(disabled.backend.generated).toHaveLength(0)
  })

  it('默认不吞掉前置提及聊天，启用后只发一次并早于聊天中间件', async () => {
    const normal = await setup()
    let passed = false
    normal.ctx.middleware(() => { passed = true })
    await normal.receive('<at id="bot"/> 普通聊天')
    expect(passed).toBe(true)
    expect(normal.sent).toHaveLength(0)
    const enabled = await setup({ allowLeadingAtBeforeCommand: true })
    enabled.ctx.middleware(() => '不能进入聊天处理')
    await enabled.receive('<at id="other"/> meme hello 测试')
    expect(enabled.backend.generated).toHaveLength(1)
    expect(enabled.sent.filter((text) => text.includes('<img'))).toHaveLength(1)
    expect(enabled.sent.join('')).not.toContain('不能进入聊天处理')
  })

  it('默认允许模板 key 无前缀触发，不依赖中文别名开关', async () => {
    const app = await setup()
    await vi.waitFor(() => expect(app.ctx.$processor._matchers.size).toBeGreaterThan(0))
    await app.receive('hello 无前缀文字')
    expect(app.backend.generated).toHaveLength(1)
    expect(app.backend.generated[0].key).toBe('hello')
    expect(app.backend.generated[0].texts).toEqual(['无前缀文字'])
    expect(app.sent.filter((text) => text.includes('<img'))).toHaveLength(1)
  })

  it('显式关闭模板 key 直触发后放行聊天，带前缀命令仍可用', async () => {
    const app = await setup({ allowKeyWithoutPrefixTrigger: false })
    let passed = false
    app.ctx.middleware(() => { passed = true })
    await app.receive('hello 普通聊天')
    expect(passed).toBe(true)
    expect(app.backend.generated).toHaveLength(0)
    expect(await app.execute('meme hello 命令文字')).toContain('<img')
    expect(app.backend.generated[0].texts).toEqual(['命令文字'])
  })

  it('无前缀别名和贴合参数由独立开关控制，卸载后移除', async () => {
    const app = await setup({ enableDirectAliasWithoutPrefix: true, allowMentionPrefixDirectAliasTrigger: true, enableMemeCommandTrigger: false })
    await vi.waitFor(() => expect(app.ctx.$processor._matchers.size).toBeGreaterThan(0))
    await app.receive('你好贴合文字')
    expect(app.backend.generated[0].texts).toEqual(['贴合文字'])
    await app.fiber.dispose()
    expect(app.ctx.$commander.get('meme')).toBeUndefined()
    expect(app.ctx.$commander.get('meme.info')).toBeUndefined()
    expect(app.ctx.$processor._matchers.size).toBe(0)
  })

  it('图片在命令前后均可生成，图片段不混入文字参数', async () => {
    const app = await setup()
    app.backend.templates.set('portrait', meme('portrait', { min_images: 1, max_images: 1, min_texts: 0, max_texts: 0, default_texts: [] }))
    const image = '<img src="data:image/png;base64,AQID"/>'
    await app.receive(`${image}meme portrait`)
    await app.receive(`meme portrait ${image}`)
    expect(app.backend.generated).toHaveLength(2)
    expect(app.backend.generated.every((item) => item.images.length === 1 && item.texts.length === 0)).toBe(true)
    expect(app.sent.filter((text) => text.includes('<img'))).toHaveLength(2)
    let passed = false
    app.ctx.middleware(() => { passed = true })
    await app.receive(`${image}普通图片消息`)
    expect(passed).toBe(true)
    expect(app.backend.generated).toHaveLength(2)
  })

  it.each(Array.from({ length: 32 }, (_, mask) => ({
    enableMemeCommandTrigger: Boolean(mask & 1),
    enableDirectAliasWithoutPrefix: Boolean(mask & 2),
    allowLeadingAtBeforeCommand: Boolean(mask & 4),
    allowKeyWithoutPrefixTrigger: Boolean(mask & 8),
    allowMentionPrefixDirectAliasTrigger: Boolean(mask & 16)
  })))('前置中文别名不依赖主命令、key 或贴合开关：%j', async (config) => {
    const app = await setup(config)
    const aliasEnabled = config.enableDirectAliasWithoutPrefix && config.allowLeadingAtBeforeCommand
    await app.receive('<at id="other"/> 你好 第一段 第二段')
    expect(app.backend.generated).toHaveLength(Number(aliasEnabled))
    expect(app.sent.filter((text) => text.includes('<img'))).toHaveLength(Number(aliasEnabled))
    if (aliasEnabled) expect(app.backend.generated[0].texts).toEqual(['第一段', '第二段'])
    await app.receive('meme hello 主命令')
    expect(app.backend.generated).toHaveLength(Number(aliasEnabled) + Number(config.enableMemeCommandTrigger))
  })

  it.each([false, true])('前置中文别名保留引号文案边界：主命令=%s', async (enabled) => {
    const app = await setup({
      enableMemeCommandTrigger: enabled, enableDirectAliasWithoutPrefix: true,
      allowLeadingAtBeforeCommand: true
    })
    await app.receive('<at id="other"/> 你好 "第一段 文案" 第二段')
    await app.receive('<at id="other"/> 你好 “中文 空格” user@example.com')
    expect(app.backend.generated.map((item) => item.texts)).toEqual([
      ['第一段 文案', '第二段'], ['中文 空格', 'user@example.com']
    ])
    expect(app.sent.filter((text) => text.includes('<img'))).toHaveLength(2)
  })

  it.each([
    { excludedMemeKeys: ['HELLO'] },
    { groupExcludedMemeKeys: [{ groupId: 'group', excludedMemeKeys: ['HELLO'] }] },
    { excludeTextOnlyMemes: true }
  ])('前置中文别名保持模板排除与错误静默策略：%j', async (exclusion) => {
    for (const silent of [false, true]) {
      const app = await setup({
        enableMemeCommandTrigger: false, enableDirectAliasWithoutPrefix: true,
        allowLeadingAtBeforeCommand: true, disableErrorReplyToPlatform: silent, ...exclusion
      })
      await app.receive('<at id="other"/> 你好 测试')
      expect(app.backend.generated).toHaveLength(0)
      expect(app.sent.join('')).toBe(silent ? '' : '该模板已被排除。')
    }
  })

  it.each([false, true])('前置中文别名的后端错误遵守静默配置：%s', async (silent) => {
    const app = await setup({
      enableMemeCommandTrigger: false, enableDirectAliasWithoutPrefix: true,
      allowLeadingAtBeforeCommand: true, disableErrorReplyToPlatform: silent
    })
    app.backend.failures.set('hello', 541)
    await app.receive('<at id="other"/> 你好 测试')
    expect(app.backend.generated).toHaveLength(1)
    expect(app.sent.join('')).toBe(silent ? '' : '模板生成失败')
  })

  it.each([false, true])('主命令提及仅参与头像补全，不进入文案：静默=%s', async (silent) => {
    const app = await setup({ disableErrorReplyToPlatform: silent })
    app.backend.templates.set('portrait', meme('portrait', { min_images: 1, max_images: 1, min_texts: 0, max_texts: 0, default_texts: [] }))
    app.bot.getUser = async (id: string) => ({ id, name: id, avatar: `data:image/png;base64,${id === 'other' ? 'BAUG' : 'AQID'}` })
    await app.receive('meme portrait <at id="other"/>')
    expect(app.backend.generated[0].texts).toEqual([])
    expect(app.backend.generated[0].images).toHaveLength(1)
    const image = app.backend.generated[0].images[0]
    if (typeof image === 'string') throw new Error('应上传目标头像文件')
    expect(Buffer.from(await image.arrayBuffer())).toEqual(Buffer.from([4, 5, 6]))
    expect(app.sent.filter((text) => text.includes('<img'))).toHaveLength(1)
    await app.receive('meme hello <at id="other"/> "带空格 文案" user@example.com')
    expect(app.backend.generated[1].texts).toEqual(['带空格 文案', 'user@example.com'])
    expect(app.sent.filter((text) => text.includes('<img'))).toHaveLength(2)
  })

  it('内联发送者与机器人头像经过原有策略补全', async () => {
    const app = await setup()
    app.backend.templates.set('duo', meme('duo', { min_images: 2, max_images: 2, min_texts: 0, max_texts: 0, default_texts: [] }))
    app.bot.getUser = async (id: string) => ({ id, name: '用户', avatar: 'data:image/png;base64,AQID' })
    Object.assign(app.bot.user, { avatar: 'data:image/png;base64,BAUG' })
    expect(await app.execute('meme duo')).toContain('<img')
    expect(app.backend.generated[0].images).toHaveLength(2)
  })

  it('关闭错误平台回复时静默，搜索无结果仍可见', async () => {
    const app = await setup({ disableErrorReplyToPlatform: true })
    expect(await app.execute('meme.preview missing')).toBe('')
    expect(await app.execute('meme.search 不存在的关键词')).toContain('未找到相关表情')
  })
})
