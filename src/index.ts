import type { Context } from 'cordis'
import { httpFetch } from '@chatluna/utils'
import type {} from '@chatluna/ui-server'
import { Config, defaultConfig } from './config'
import { MemeBackendClient } from './backend'
import { registerCommands } from './command/register'
import { registerTools } from './tools'
import { registerMemeAction } from './actions'

export const name = 'chatluna-meme-generator'
export { Config }
export const inject = ['koishi', 'http']

export function apply(ctx: Context, config: Config) {
  const resolved = { ...defaultConfig, ...config }
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  const client = new MemeBackendClient(resolved, httpFetch(ctx.http), lifetime.signal)
  const runtime = registerCommands(ctx, resolved, client)
  ctx.inject(['chatluna_webui'], (ctx) => {
    ctx.chatluna_webui.addEntry({
      baseUrl: import.meta.url,
      source: '../client/index.ts',
      bundle: '../dist/client.js'
    })
  })
  if (resolved.enableMemeXmlTool) {
    ctx.inject(['chat'], (ctx) => registerMemeAction(ctx, resolved, runtime))
    ctx.inject(['tools', 'chat'], (ctx) => registerTools(ctx, resolved, runtime))
  }
}
