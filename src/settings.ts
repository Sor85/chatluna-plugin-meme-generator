import type { Context } from 'cordis'
import type { Session } from '@satorijs/core'
import type { Schema } from '@chatluna/schema'
import { routeIdOfSessionId } from '@chatluna/satori'
import { assignDefined } from '@chatluna/utils/object'
import type { Resolution } from '@chatluna/routing'
import type {} from '@chatluna/ui-schema-registry'
import { type Config, type RouteSettings, pickRouteSettings, routeSchema } from './config'
import { normalizeGroupId, normalizeMemeKey, resolveSessionGroupId } from './command/register/exclusion'

export const ROUTE_NAMESPACE = 'meme-generator'

/** The PromptEnvironment fields that place a model prompt in a conversation. */
export interface PromptScene {
  readonly sessionId?: string
  readonly platform?: string
  readonly selfId?: string
  readonly isDirect?: boolean
  readonly guildId?: string
  readonly channelId?: string
  readonly userId?: string
}

/**
 * Per-conversation settings: the routing rules' `meme-generator` namespace over the plugin config.
 * Values saved before the move live on in the plugin config as hidden fields and act as the namespace defaults.
 */
export class MemeSettings {
  readonly schema: Schema<RouteSettings>
  private readonly groups = new Map<string, string[]>()
  private readonly sessions = new WeakMap<Session, Config>()

  constructor(private ctx: Context, readonly config: Config) {
    this.schema = routeSchema(pickRouteSettings(config))
    for (const rule of config.groupExcludedMemeKeys) {
      const groupId = normalizeGroupId(rule.groupId)
      if (groupId) this.groups.set(groupId, [...(this.groups.get(groupId) ?? []), ...rule.excludedMemeKeys])
    }
  }

  /** Shows the namespace under 对话设置 → 插件; the owner's disposal removes it. */
  register(ctx: Context) {
    ctx.schemas.section({
      surface: 'routing',
      key: ROUTE_NAMESPACE,
      id: ROUTE_NAMESPACE,
      title: '表情包生成',
      tab: 'rules.plugins',
      schema: this.schema,
      applies: 'live',
      plugin: 'chatluna-plugin-meme-generator'
    })
  }

  /** The settings in effect for a platform message; without one, those of the rules that match everywhere. */
  of(session: Session | undefined): Config {
    if (!session) return this.resolve(this.ctx.get('routing')?.resolve({ platform: '', selfId: '', isDirect: false }), '')
    let settings = this.sessions.get(session)
    if (!settings) {
      const routing = this.ctx.get('routing')
      settings = this.resolve(routing?.resolve(routing.matchInput(session)), resolveSessionGroupId(session))
      this.sessions.set(session, settings)
    }
    return settings
  }

  /** The settings in effect for a model prompt's conversation. */
  at(scene: PromptScene): Config {
    const routeId = scene.sessionId === undefined ? undefined : routeIdOfSessionId(scene.sessionId)
    const input = assignDefined(
      { platform: scene.platform ?? '', selfId: scene.selfId ?? '', isDirect: scene.isDirect ?? false },
      { guildId: scene.guildId, channelId: scene.channelId, userId: scene.userId, routeId }
    )
    return this.resolve(this.ctx.get('routing')?.resolve(input), scene.isDirect ? '' : normalizeGroupId(scene.guildId))
  }

  private resolve(resolution: Resolution | undefined, groupId: string): Config {
    const settings = this.schema.parse(structuredClone(resolution?.get(ROUTE_NAMESPACE) ?? {}))
    // The old per-group list adds to the excluded templates until a rule sets that field for the conversation.
    const legacy = this.groups.get(groupId)
    if (legacy && !Object.hasOwn(resolution?.sources ?? {}, `${ROUTE_NAMESPACE}.excludedMemeKeys`))
      settings.excludedMemeKeys = [...settings.excludedMemeKeys, ...legacy]
    return { ...this.config, ...settings }
  }
}

/** Normalized template keys a conversation excludes by key; category exclusion needs template info and is applied by callers. */
export function excludedKeys(settings: Config): Set<string> {
  return new Set(settings.excludedMemeKeys.map(normalizeMemeKey).filter(Boolean))
}

declare module '@chatluna/routing' {
  interface RuleValueMap {
    'meme-generator': Partial<RouteSettings> | undefined
  }
}
