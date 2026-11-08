import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMentionedTargetDisplayName, resolveDisplayNameByUserId } from '../src/utils/avatar'
import { host } from './helpers/host'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0)) await close() })
async function setup() { const app = await host(); cleanup.push(app.close); return app }

describe('Satori 标准提及与昵称', () => {
  it.each([
    { member: { nick: '群昵称', name: '群名称', user: { id: 'target', name: '用户名称' } }, expected: '群昵称' },
    { member: { name: '群名称', user: { id: 'target', nick: '用户昵称', name: '用户名称' } }, expected: '群名称' },
    { member: { user: { id: 'target', nick: '用户昵称', name: '用户名称' } }, expected: '用户昵称' },
    { member: { user: { id: 'target', name: '用户名称' } }, expected: '用户名称' }
  ])('按群成员与用户的标准字段解析昵称：$expected', async ({ member, expected }) => {
    const app = await setup()
    vi.spyOn(app.bot, 'getGuildMember').mockResolvedValue({ nick: '', ...member })
    expect(await resolveDisplayNameByUserId(app.session(), 'target')).toBe(expected)
  })

  it('群成员查询失败后读取标准用户昵称', async () => {
    const app = await setup()
    vi.spyOn(app.bot, 'getGuildMember').mockRejectedValue(new Error('成员不可用'))
    vi.spyOn(app.bot, 'getUser').mockResolvedValue(Object.assign({ id: 'target', name: '用户名称' }, { nick: '用户昵称' }))
    expect(await resolveDisplayNameByUserId(app.session(), 'target')).toBe('用户昵称')
  })

  it('不再读取用户资料中的旧昵称字段', async () => {
    const app = await setup()
    const user = { id: 'target', name: '', nickname: '旧昵称', username: '旧用户名' }
    vi.spyOn(app.bot, 'getGuildMember').mockResolvedValue({ nick: '', user })
    vi.spyOn(app.bot, 'getUser').mockResolvedValue(user)
    expect(await resolveDisplayNameByUserId(app.session(), 'target')).toBeUndefined()
  })

  it('提及使用标准 id/name，不识别旧 userId/qq 属性', async () => {
    const app = await setup()
    expect(await getMentionedTargetDisplayName(app.session('<at id="target" name="提及昵称"/>'))).toBe('提及昵称')
    expect(await getMentionedTargetDisplayName(app.session('<at id="target"/>'))).toBe('群昵称-target')
    for (const field of ['userId', 'qq']) {
      expect(await getMentionedTargetDisplayName(app.session(`<at ${field}="target" name="旧提及"/>`))).toBeUndefined()
    }
  })
})
