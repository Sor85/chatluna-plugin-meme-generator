import { Schema } from '@chatluna/schema'
import type { Config } from './config'
import type { BinaryResult, GenerateImageInput, MemeInfoResponse } from './types'
import { mapBackendStatus, mapNetworkError } from './errors'

const paramsSchema = Schema.object({
  min_images: Schema.natural().required(),
  max_images: Schema.natural().required(),
  min_texts: Schema.natural().required(),
  max_texts: Schema.natural().required(),
  default_texts: Schema.array(Schema.string()).default([])
})
const infoSchema = Schema.object({
  key: Schema.string().required(),
  params_type: paramsSchema.required(),
  keywords: Schema.array(Schema.string()).default([]),
  shortcuts: Schema.array(Schema.object({
    key: Schema.string().required(),
    args: Schema.array(Schema.string()),
    humanized: Schema.string()
  })).default([]),
  tags: Schema.array(Schema.string()).default([]),
  date_created: Schema.string().default(''),
  date_modified: Schema.string().default('')
})

export function imageMimeType(value: string | null, fallback = ''): string {
  const mime = value?.split(';')[0]?.trim().toLowerCase()
  if (mime && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime)) return mime
  const extension = /\.(png|jpe?g|gif|webp)(?:[?#]|$)/i.exec(fallback)?.[1]?.toLowerCase()
  return extension ? `image/${extension === 'jpg' ? 'jpeg' : extension}` : 'image/png'
}

export async function readLimitedBody(response: Response, limit: number): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel()
    throw new Error(`图片大小超过 ${limit / 1024 / 1024} MiB`)
  }
  if (!response.body) throw new Error('图片响应为空')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > limit) throw new Error(`图片大小超过 ${limit / 1024 / 1024} MiB`)
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
  if (!length) throw new Error('图片响应为空')
  return Buffer.concat(chunks, length)
}

export class MemeBackendClient {
  constructor(private config: Config, private request: typeof fetch = fetch, private lifetime?: AbortSignal) {}

  private async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    if (!this.config.baseUrl.trim()) throw new Error('尚未配置 meme-generator 后端地址')
    const url = new URL(`${this.config.baseUrl.replace(/\/+$/, '')}${path}`)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('后端地址必须使用 HTTP 或 HTTPS')
    const timeout = AbortSignal.timeout(this.config.timeoutMs)
    const signals = [timeout, ...(init.signal ? [init.signal] : []), ...(this.lifetime ? [this.lifetime] : [])]
    const signal = AbortSignal.any(signals)
    let response: Response
    try {
      response = await this.request(url, { ...init, signal, redirect: 'error' })
    } catch (error) {
      if (init.signal?.aborted) throw init.signal.reason
      throw new Error(mapNetworkError(error), { cause: error })
    }
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => undefined)
      const detail = body && typeof body === 'object' && 'detail' in body && typeof body.detail === 'string'
        ? body.detail : undefined
      throw new Error(mapBackendStatus(response.status, detail))
    }
    return response
  }

  async getKeys(signal?: AbortSignal): Promise<string[]> {
    const response = await this.fetch('/memes/keys', { signal })
    const result = Schema.array(Schema.string()).safeParse(await response.json())
    if (!result.success) throw new Error('后端模板列表格式错误')
    return result.data
  }

  async getInfo(key: string, signal?: AbortSignal): Promise<MemeInfoResponse> {
    const response = await this.fetch(`/memes/${encodeURIComponent(key)}/info`, { signal })
    const result = infoSchema.safeParse(await response.json())
    if (!result.success) throw new Error(`模板 ${key} 的信息格式错误`)
    const params = result.data.params_type
    if (params.min_images > params.max_images || params.min_texts > params.max_texts) {
      throw new Error(`模板 ${key} 的参数范围错误`)
    }
    return result.data
  }

  async getPreview(key: string, signal?: AbortSignal): Promise<BinaryResult> {
    const response = await this.fetch(`/memes/${encodeURIComponent(key)}/preview`, { signal })
    return { buffer: await readLimitedBody(response, 50 * 1024 * 1024), mimeType: imageMimeType(response.headers.get('content-type')) }
  }

  async generate(key: string, images: GenerateImageInput[], texts: string[], args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<BinaryResult> {
    const body = new FormData()
    for (const image of images) body.append('images', new Blob([new Uint8Array(image.data)], { type: image.mimeType }), image.filename)
    for (const text of texts) body.append('texts', text)
    body.append('args', JSON.stringify(args))
    const response = await this.fetch(`/memes/${encodeURIComponent(key)}/`, { method: 'POST', body, signal })
    return { buffer: await readLimitedBody(response, 50 * 1024 * 1024), mimeType: imageMimeType(response.headers.get('content-type')) }
  }
}
