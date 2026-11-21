import type { Context } from 'cordis'
import { Schema } from '@chatluna/schema'
import type {} from '@chatluna/ui-server'
import type {} from '@chatluna/ui-client/client'
import type { RandomMemeBucketCategory } from './config'
import type { MemeBackendClient } from './backend'
import { aliases, type MemeSearchIndex } from './search'
import { resolveRandomMemeBucket } from './command/random'
import { pickChineseAlias } from './command/register/meme-list'
import type {} from 'chatluna-plugin-takumi'

export interface MemeTemplateOption {
  key: string
  name: string
  /** Searchable text: key, keywords, aliases and tags. */
  detail: string
  category: RandomMemeBucketCategory
}

export interface MemeTemplateCatalog {
  templates: MemeTemplateOption[]
  failed: number
}

declare module '@chatluna/ui-client/client' {
  interface States {
    'meme-generator.templates': MemeTemplateCatalog
  }
  interface Actions {
    /** A WebP data URL of the template preview, shrunk for the picker grid. */
    'meme-generator.preview'(input: { key: string }): string
  }
}

const THUMBNAIL_SIZE = 96
const CACHE_LIMIT = 1024
const PARALLEL = 4

/** The settings page's template picker: the catalog comes from the shared search index, previews from the backend. */
export function registerWebUI(ctx: Context, client: MemeBackendClient, index: MemeSearchIndex, signal: AbortSignal) {
  const webui = ctx.chatluna_webui
  webui.addEntry({ baseUrl: import.meta.url, source: '../client/index.ts', bundle: '../dist/client.js' })
  webui.state('meme-generator.templates', {
    async get() {
      const { infos, failed } = await index.catalog(signal)
      return {
        failed,
        templates: infos.map((info) => ({
          key: info.key,
          name: pickChineseAlias(info),
          detail: [...new Set([info.key, ...info.keywords, ...aliases(info), ...info.tags])].join(' '),
          category: resolveRandomMemeBucket(info.params_type)
        }))
      }
    }
  })

  // Thumbnails are a few KB, so the whole catalog stays in memory; failures are dropped and retried on the next request.
  const cache = new Map<string, Promise<string>>()
  let running = 0
  const waiting: (() => void)[] = []
  const acquire = () => new Promise<void>((resolve) => {
    if (running < PARALLEL) {
      running++
      resolve()
    } else waiting.push(resolve)
  })
  const release = () => {
    const next = waiting.shift()
    if (next) next()
    else running--
  }
  const thumbnail = async (key: string) => {
    await acquire()
    try {
      const preview = await client.getPreview(key, signal)
      const takumi = ctx.get('takumi')
      if (!takumi) throw new Error('Takumi rendering service is not enabled')
      const image = await takumi.render('<img src="thumbnail" style="width:100%;height:100%;object-fit:contain">', {
        width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE, format: 'webp', quality: 80, signal, fetch: async () => preview.buffer
      })
      return `data:image/webp;base64,${image.toString('base64')}`
    } finally {
      release()
    }
  }
  webui.action('meme-generator.preview', { input: Schema.object({ key: Schema.string().min(1).max(200).required() }) }, ({ key }) => {
    const cached = cache.get(key)
    if (cached) return cached
    const task = thumbnail(key)
    task.catch(() => {
      if (cache.get(key) === task) cache.delete(key)
    })
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value ?? '')
    cache.set(key, task)
    return task
  })
}
