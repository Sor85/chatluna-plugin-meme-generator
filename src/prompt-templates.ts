import type { MemeBackendClient } from './backend'
import type { MemeInfoResponse } from './types'
import { normalizeMemeKey } from './command/register/exclusion'
import { isParamsTypeExcludedByConfig } from './command/register/meme-list'
import { aliases } from './search'
import { excludedKeys, type MemeSettings, type PromptScene } from './settings'

const RETRY_MS = 60_000

function count(min: number, max: number, noun: string) {
  if (max <= 0) return ''
  return `${min === max ? min : `${min}-${max}`} ${noun}${max > 1 ? 's' : ''}`
}

export function describeTemplate(key: string, info: MemeInfoResponse | undefined) {
  if (!info) return `- ${key}`
  const names = [...new Set([...info.keywords, ...aliases(info)])].filter((name) => name !== info.key).slice(0, 4)
  const params = info.params_type
  const inputs = [count(params.min_images, params.max_images, 'image'), count(params.min_texts, params.max_texts, 'text')].filter(Boolean)
  return `- ${info.key}${names.length ? ` (${names.join(', ')})` : ''}: ${inputs.join(', ') || 'no inputs'}`
}

/**
 * The configured `promptMemeKeys`, written into the `meme` action's prompt.
 * Action prompts are synchronous, so template info is fetched ahead and a key whose info is missing is listed bare.
 */
export class PromptTemplates {
  private infos = new Map<string, MemeInfoResponse>()
  private loading?: Promise<void>
  private retryAt = 0
  private keys: string[]

  constructor(private settings: MemeSettings, private client: MemeBackendClient, private signal: AbortSignal) {
    this.keys = [...new Set(settings.config.promptMemeKeys.map((key) => key.trim()).filter(Boolean))]
    this.load()
  }

  private load() {
    const missing = this.keys.filter((key) => !this.infos.has(key))
    if (this.loading || !missing.length || Date.now() < this.retryAt || this.signal.aborted) return
    this.loading = (async () => {
      let next = 0
      await Promise.all(Array.from({ length: Math.min(4, missing.length) }, async () => {
        while (next < missing.length && !this.signal.aborted) {
          const key = missing[next++]
          const info = await this.client.getInfo(key, this.signal).catch(() => undefined)
          if (info) this.infos.set(key, info)
        }
      }))
    })().finally(() => {
      this.loading = undefined
      // A down backend is retried on a later prompt, not on every one.
      if (this.keys.some((key) => !this.infos.has(key))) this.retryAt = Date.now() + RETRY_MS
    })
  }

  /** Resolves once the pending fetch settles; for tests. */
  ready() {
    return this.loading ?? Promise.resolve()
  }

  prompt(env: PromptScene): string {
    this.load()
    const settings = this.settings.at(env)
    const excluded = excludedKeys(settings)
    const lines = this.keys.flatMap((key) => {
      const info = this.infos.get(key)
      if (excluded.has(normalizeMemeKey(info?.key ?? key))) return []
      if (info && isParamsTypeExcludedByConfig(info.params_type, settings)) return []
      return [describeTemplate(key, info)]
    })
    if (!lines.length) return ''
    return ['Preset <meme> templates, usable directly without meme_search (key (names): inputs):', ...lines].join('\n')
  }
}
