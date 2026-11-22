import { afterEach, describe, expect, it, vi } from 'vitest'
import { host } from './helpers/host'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

function rule(id: string, guild: string | undefined, values: Record<string, unknown>) {
  return {
    id, enabled: true, revision: 1, createdAt: 0, updatedAt: 0,
    filter: guild === undefined ? { kind: 'true' } : { kind: 'scope', field: 'guild', values: [guild] },
    values: { 'meme-generator': values }
  }
}
async function setup(config: Parameters<typeof host>[0], rules: unknown[], schemas = true) {
  const value = await host(config, { rules, schemas })
  cleanup.push(value.close)
  return value
}

describe('对话设置按会话覆盖', () => {
  it('注册到插件标签页，旧插件配置作为未设置时的默认值', async () => {
    const app = await setup({ enableQuotedTextTrigger: true, excludedMemeKeys: ['world'] }, [])
    const decl = app.ctx.schemas.namespace('meme-generator')
    expect(decl).toMatchObject({ tab: 'rules.plugins', applies: 'live', plugin: 'chatluna-plugin-meme-generator' })
    const defaults = decl?.schema.parse({})
    expect(defaults).toMatchObject({ enableQuotedTextTrigger: true, excludedMemeKeys: ['world'], enableMemeCommandTrigger: true })
    expect(defaults).not.toHaveProperty('baseUrl')
    for (const group of decl?.schema.list ?? []) {
      for (const field of Object.values(group.dict ?? {})) {
        expect(field.meta.label).toBeTruthy()
        expect(field.meta.description).toBeTruthy()
      }
    }
    await app.fiber.dispose()
    expect(app.ctx.schemas.namespace('meme-generator')).toBeUndefined()
  })

  it('命名空间未注册时退回插件配置，不抛错', async () => {
    const app = await setup({ excludedMemeKeys: ['world'], enableDirectAliasWithoutPrefix: true }, [], false)
    await vi.waitFor(() => expect(app.ctx.$processor._matchers.size).toBeGreaterThan(0))
    expect(await app.execute('meme world')).toContain('已被排除')
    expect(await app.execute('meme hello')).toContain('<img')
  })

  it('群规则覆盖全局规则，未匹配的群沿用全局值', async () => {
    const app = await setup({}, [
      rule('global', undefined, { excludedMemeKeys: ['world'] }),
      rule('quiet', 'quiet', { enableMemeCommandTrigger: false }),
      rule('open', 'open', { excludedMemeKeys: [] })
    ])
    expect(await app.execute('meme hello', 'quiet')).toBe('')
    expect(app.backend.generated).toHaveLength(0)
    expect(await app.execute('meme world', 'group')).toContain('已被排除')
    expect(await app.execute('meme.info world', 'quiet')).toContain('已被排除')
    expect(await app.execute('meme world', 'open')).toContain('<img')
    expect(await app.execute('meme hello', 'group')).toContain('<img')
    expect(app.backend.generated).toHaveLength(2)
  })

  it('旧分群排除在规则未设置排除模板时继续生效', async () => {
    const app = await setup({ groupExcludedMemeKeys: [{ groupId: 'legacy', excludedMemeKeys: ['hello'] }, { groupId: 'cleared', excludedMemeKeys: ['hello'] }] }, [
      rule('cleared', 'cleared', { excludedMemeKeys: [] })
    ])
    expect(await app.execute('meme hello', 'legacy')).toContain('已被排除')
    expect(await app.execute('meme hello', 'cleared')).toContain('<img')
    expect(await app.execute('meme hello', 'group')).toContain('<img')
  })

  it('无前缀别名按群开启，其他群的消息继续交给普通聊天', async () => {
    const app = await setup({ enableDirectAliasWithoutPrefix: false, allowKeyWithoutPrefixTrigger: false }, [
      rule('alias', 'alias', { enableDirectAliasWithoutPrefix: true })
    ])
    await vi.waitFor(() => expect(app.ctx.$processor._matchers.size).toBeGreaterThan(0))
    await app.receive('你好 文字', 'group')
    expect(app.backend.generated).toHaveLength(0)
    await app.receive('你好 文字', 'alias')
    expect(app.backend.generated.map((item) => item.texts)).toEqual([['文字']])
    await app.receive('hello 文字', 'alias')
    expect(app.backend.generated).toHaveLength(1)
  })

  it('注入模板按会话选择，旧取值作为默认值', async () => {
    const app = await setup({ promptMemeKeys: ['world'] }, [rule('tpl', 'tpl', { promptMemeKeys: ['hello'] }), rule('none', 'none', { promptMemeKeys: [] })])
    const prompt = (guildId: string) => {
      const value = app.actions.get('meme')?.prompt
      if (typeof value !== 'function') throw new Error('meme 动作没有动态提示')
      return value({ now: 0, platform: 'onebot', selfId: 'bot', isDirect: false, guildId })
    }
    await vi.waitFor(() => expect(prompt('tpl')).toContain('- hello (你好)'))
    expect(prompt('tpl')).not.toContain('world')
    await vi.waitFor(() => expect(prompt('group')).toContain('- world (世界)'))
    expect(prompt('none')).toBe('')
  })

  it('错误静默与类别排除按群读取', async () => {
    const app = await setup({ disableErrorReplyToPlatform: false }, [
      rule('silent', 'silent', { disableErrorReplyToPlatform: true, excludeTextOnlyMemes: true })
    ])
    expect(await app.execute('meme hello', 'silent')).toBe('')
    expect(app.backend.generated).toHaveLength(0)
    expect(await app.execute('meme hello', 'group')).toContain('<img')
  })
})
