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
 * The conversation's `promptMemeKeys`, written into the `meme` action's prompt.
 * Action prompts are synchronous, so template info is fetched in the background and a key whose info is missing is listed bare.
 */
export class PromptTemplates {
  private infos = new Map<string, MemeInfoResponse>()
  private pending = new Set<string>()
  /** Key → time before which a failed fetch is not retried. */
  private failed = new Map<string, number>()
  private loads = new Set<Promise<void>>()

  constructor(private settings: MemeSettings, private client: MemeBackendClient, private signal: AbortSignal) {
    // Prefetch the templates of the rules that match everywhere; other conversations' keys load on their first prompt.
    this.load(keysOf(settings.of(undefined)))
  }

  private load(keys: string[]) {
    const now = Date.now()
    const missing = keys.filter((key) => !this.infos.has(key) && !this.pending.has(key) && (this.failed.get(key) ?? 0) <= now)
    if (!missing.length || this.signal.aborted) return
    for (const key of missing) this.pending.add(key)
    const load = (async () => {
      let next = 0
      await Promise.all(Array.from({ length: Math.min(4, missing.length) }, async () => {
        while (next < missing.length && !this.signal.aborted) {
          const key = missing[next++]
          const info = await this.client.getInfo(key, this.signal).catch(() => undefined)
          // A down backend is retried on a later prompt, not on every one.
          if (info) this.infos.set(key, info)
          else this.failed.set(key, Date.now() + RETRY_MS)
        }
      }))
    })().finally(() => {
      for (const key of missing) this.pending.delete(key)
      this.loads.delete(load)
    })
    this.loads.add(load)
  }

  /** Resolves once the pending fetches settle; for tests. */
  async ready() {
    await Promise.all(this.loads)
  }

  prompt(env: PromptScene): string {
    const settings = this.settings.at(env)
    const keys = keysOf(settings)
    if (!keys.length) return ''
    this.load(keys)
    const excluded = excludedKeys(settings)
    const lines = keys.flatMap((key) => {
      const info = this.infos.get(key)
      if (excluded.has(normalizeMemeKey(info?.key ?? key))) return []
      if (info && isParamsTypeExcludedByConfig(info.params_type, settings)) return []
      return [describeTemplate(key, info)]
    })
    if (!lines.length) return ''
    return ['Preset <meme> templates, usable directly without meme_search (key (names): inputs):', ...lines].join('\n')
  }
}

function keysOf(settings: { promptMemeKeys: string[] }) {
  return [...new Set(settings.promptMemeKeys.map((key) => key.trim()).filter(Boolean))]
}
