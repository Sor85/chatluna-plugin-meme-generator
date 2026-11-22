import type { Context } from 'cordis'
import { httpFetch } from '@chatluna/utils'
import type {} from '@chatluna/ui-server'
import { Config, defaultConfig } from './config'
import { MemeBackendClient } from './backend'
import { registerCommands } from './command/register'
import { registerTools } from './tools'
import { registerMemeAction } from './actions'
import { MemeSearchIndex } from './search'
import { registerWebUI } from './webui'
import { MemeSettings } from './settings'

export const name = 'chatluna-meme-generator'
export { Config }
export const inject = ['koishi', 'http', 'takumi']

export function apply(ctx: Context, config: Config) {
  const resolved = { ...defaultConfig, ...config }
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  const settings = new MemeSettings(ctx, resolved)
  // Conversation-level fields show under 对话设置 → 插件 while the settings registry is loaded.
  ctx.inject(['schemas'], (ctx) => settings.register(ctx))
  const client = new MemeBackendClient(resolved, httpFetch(ctx.http), lifetime.signal)
  const runtime = registerCommands(ctx, settings, client)
  // One metadata snapshot serves both the meme_search tool and the settings page's template picker.
  const index = new MemeSearchIndex(resolved, client)
  ctx.inject(['chatluna_webui'], (ctx) => registerWebUI(ctx, client, index, lifetime.signal))
  // Whether the model may use them is up to ChatLuna's own action and tool settings.
  ctx.inject(['chat'], (ctx) => registerMemeAction(ctx, resolved, runtime))
  ctx.inject(['tools', 'chat'], (ctx) => registerTools(ctx, runtime, index))
}
