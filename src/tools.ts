import type { Context } from 'cordis'
import { Schema } from '@chatluna/schema'
import type { ToolDefinition } from '@chatluna/tool'
import type {} from '@chatluna/chat'
import type { Config } from './config'
import type { registerCommands } from './command/register'
import { buildExcludedMemeKeySet, buildGroupExcludedMemeKeySets, normalizeMemeKey, resolveSessionGroupId } from './command/register/exclusion'
import { isParamsTypeExcludedByConfig } from './command/register/meme-list'
import { MemeSearchIndex } from './search'

interface SearchArgs { keywords: string | string[]; limit: number }

export function registerTools(ctx: Context, config: Config, runtime: ReturnType<typeof registerCommands>) {
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  const index = new MemeSearchIndex(config, runtime.client)
  const excluded = buildExcludedMemeKeySet(config)
  const groups = buildGroupExcludedMemeKeySets(config)
  const tool: ToolDefinition<SearchArgs> = {
    name: 'meme_search',
    description: 'Find available meme templates before using the <meme> action. Supply one or several template keys, aliases or short keywords; alternatives are combined and deduplicated. Matching is literal against template keys, aliases, tags and default texts, ignoring letter case; use concise keywords rather than long scene descriptions. Exact key/alias matches rank first. Returns exact template keys, aliases, tags and required image/text counts. This tool ONLY searches: it never generates or sends images. Select a returned key and use <meme key="..." text="..." at="..."/> to generate and send. Do not invent template keys; refine the keywords if no template matches.',
    locales: { zh: { description: '只读查询可用表情模板，支持多个关键词；结果包含模板键与参数要求，生成发送由 meme 动作执行' } },
    args: Schema.object({
      keywords: Schema.union([Schema.string().min(1).max(200), Schema.array(Schema.string().min(1).max(200)).min(1).max(8)]).required().description('One keyword or up to 8 alternatives. Array items are searched together; no images or messages are sent.'),
      limit: Schema.number().min(1).max(10).step(1).default(5).description('Maximum number of matching templates')
    }),
    traits: { effect: 'read', parallel: false, timeout: 120000, background: false },
    async run(args, call) {
      const session = call.routeId ? ctx.chat.inbound(call.routeId) : undefined
      if (!session) throw new Error('meme_search 需要绑定平台会话以应用当前群的模板限制')
      const signal = AbortSignal.any([call.signal, lifetime.signal])
      const groupExcluded = groups.get(resolveSessionGroupId(session))
      return index.search({ keywords: typeof args.keywords === 'string' ? [args.keywords] : args.keywords, limit: args.limit }, (info) => {
        const key = normalizeMemeKey(info.key)
        return !excluded.has(key) && !groupExcluded?.has(key) && !isParamsTypeExcludedByConfig(info.params_type, config)
      }, signal)
    },
    render: { result: (_args, value) => ({ kind: 'generic', title: 'meme_search', content: [{ type: 'text', text: JSON.stringify(value) }] }) }
  }
  ctx.tools.define(tool)
  ctx.logger.info('Registered read-only meme_search tool')
}
