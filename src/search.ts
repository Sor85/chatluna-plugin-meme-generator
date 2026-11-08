import type { Config } from './config'
import type { MemeBackendClient } from './backend'
import type { MemeInfoResponse } from './types'
import { abortable } from './utils/abort'

export interface SearchInput { keywords: string[]; limit: number }
export interface SearchResult {
  failed_templates: number
  results: {
    key: string
    keywords: string[]
    aliases: string[]
    tags: string[]
    images: { min: number; max: number }
    texts: { min: number; max: number; defaults: string[] }
  }[]
}

function normalize(value: string) { return value.normalize('NFKC').trim().toLowerCase() }
function aliases(info: MemeInfoResponse): string[] {
  return [...new Set(info.shortcuts.flatMap((item) => [item.key, ...(item.humanized ? [item.humanized] : [])]))]
}
function keywordMatch(info: MemeInfoResponse, queries: string[]) {
  const names = [info.key, ...info.keywords, ...aliases(info)].map(normalize)
  const tags = info.tags.map(normalize)
  const text = normalize([...names, ...tags, ...info.params_type.default_texts].join('\n'))
  let score = 0
  let exact = false
  for (const query of queries) {
    if (names.includes(query)) { exact = true; score += 100 }
    else if (tags.includes(query)) score += 20
    else if (names.some((name) => name.includes(query))) score += 10
    else if (text.includes(query)) score += 1
  }
  return { exact, score }
}

/** One metadata snapshot per plugin; all matching stays local and read-only. */
export class MemeSearchIndex {
  private snapshot?: { infos: MemeInfoResponse[]; failed: number; expires: number }
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private config: Config, private client: MemeBackendClient) {}

  search(input: SearchInput, allowed: (info: MemeInfoResponse) => boolean, signal: AbortSignal): Promise<SearchResult> {
    // Serialize refreshes; one caller's cancellation does not cancel the next.
    const task = this.queue.then(() => this.query(input, allowed, signal))
    this.queue = task.catch(() => {})
    return abortable(task, signal)
  }

  private async catalog(signal: AbortSignal) {
    signal.throwIfAborted()
    if (this.snapshot && Date.now() < this.snapshot.expires) return this.snapshot
    const keys = [...new Set(await this.client.getKeys(signal))]
    const results: MemeInfoResponse[] = []
    let next = 0
    let failed = 0
    await Promise.all(Array.from({ length: Math.min(8, keys.length) }, async () => {
      while (next < keys.length) {
        signal.throwIfAborted()
        const key = keys[next++]
        try {
          const info = await this.client.getInfo(key, signal)
          if (info.key !== key) throw new Error('模板信息 key 不匹配')
          results.push(info)
        } catch (error) {
          if (signal.aborted) throw error
          failed++
        }
      }
    }))
    signal.throwIfAborted()
    if (keys.length && !results.length) throw new Error('无法读取模板信息，检索索引未建立')
    results.sort((a, b) => a.key.localeCompare(b.key))
    this.snapshot = {
      infos: results, failed,
      expires: Date.now() + (failed ? 30000 : this.config.memeSearchCacheMinutes * 60000)
    }
    return this.snapshot
  }

  private async query(input: SearchInput, allowed: (info: MemeInfoResponse) => boolean, signal: AbortSignal): Promise<SearchResult> {
    signal.throwIfAborted()
    const queries = [...new Set(input.keywords.map(normalize).filter(Boolean))]
    if (!queries.length || queries.length > 8 || queries.some((query) => query.length > 200)) throw new Error('查询需包含 1–8 个关键词，每项不超过 200 字符')
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 10) throw new Error('结果数量需为 1–10')
    const snapshot = await this.catalog(signal)
    signal.throwIfAborted()
    const ranked = snapshot.infos.filter(allowed)
      .map((info) => ({ info, ...keywordMatch(info, queries) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score || a.info.key.localeCompare(b.info.key))
    return {
      failed_templates: snapshot.failed,
      results: ranked.slice(0, input.limit).map(({ info }) => ({
        key: info.key, keywords: info.keywords, aliases: aliases(info), tags: info.tags,
        images: { min: info.params_type.min_images, max: info.params_type.max_images },
        texts: { min: info.params_type.min_texts, max: info.params_type.max_texts, defaults: info.params_type.default_texts }
      }))
    }
  }
}
