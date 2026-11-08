import { Context } from 'cordis'
import { Session, h } from '@satorijs/core'
import Koishi from 'koishi'
import Database from '@cordisjs/plugin-database'
import Http from '@cordisjs/plugin-http'
import Permissions from '@chatluna/permission'
import Tools from '@chatluna/tool'
import type { ActionInput } from '@chatluna/chat'
import { Config } from '../../src/config'
import * as plugin from '../../src/index'
import { backendFixture } from './backend'

export async function host(overrides: Partial<Config> = {}) {
  const backend = await backendFixture()
  const ctx = new Context()
  await ctx.plugin(Permissions, {})
  await ctx.plugin(Database)
  await ctx.plugin(Koishi, { prefix: ['', '/'] })
  await ctx.plugin(Http)
  await ctx.plugin(Tools, {})
  const sent: string[] = []
  const bot = {
    ctx, platform: 'onebot', selfId: 'bot', user: { id: 'bot', name: '机器人' }, logger: ctx.logger,
    async sendMessage(_channel: string, content: unknown) { sent.push(String(content)); return ['sent-id'] },
    async sendPrivateMessage(_user: string, content: unknown) { sent.push(String(content)); return ['sent-id'] },
    async getGuildMember(_guild: string, user: string) { return { nick: `群昵称-${user}`, user: { id: user, name: user } } },
    async getUser(user: string) { return { id: user, name: `昵称-${user}` } },
    async getLogin() { return { user: { id: 'bot', name: '机器人' } } }
  }
  const session = (content = '', guild = 'group') => {
    const value = new Session(bot, {
      type: 'message', selfId: 'bot', platform: 'onebot', user: { id: 'user', name: '测试用户' },
      guild: { id: guild }, channel: { id: guild, type: 0 }, message: { id: `message-${Math.random()}` }
    })
    value.content = content
    return value
  }
  let current = session()
  const actions = new Map<string, ActionInput>()
  ctx.provide('chat', {
    inbound: (route: string) => route === 'test-route' ? current : undefined,
    action(name: string, input: ActionInput) { actions.set(name, input); return () => actions.delete(name) }
  })
  const fiber = await ctx.plugin(plugin, Config({
    baseUrl: backend.url, renderMemeListAsImage: false, sendMemeListAsForward: false,
    sendMemeSearchAsForward: false, enableDirectAliasWithoutPrefix: false, initLoadRetryTimes: 0,
    disableErrorReplyToPlatform: false, ...overrides
  }))
  return {
    ctx, backend, bot, sent, actions, session, fiber,
    setCurrent(value: Session) { current = value },
    async execute(input: string, guild = 'group') {
      const value = session(input, guild)
      current = value
      return (await value.execute(input, true)).map(String).join('')
    },
    async receive(input: string) {
      const value = session(input)
      current = value
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { off(); reject(new Error('Middleware did not settle')) }, 5000)
        const off = ctx.on('middleware', (finished: Session) => {
          if (finished.id !== value.id) return
          clearTimeout(timer)
          off()
          resolve()
        })
        ctx.emit('message', value)
      })
      return value
    },
    async close() { await ctx.fiber.dispose(); await backend.close() }
  }
}
