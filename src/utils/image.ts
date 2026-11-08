import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Context } from 'cordis'
import type { GenerateImageInput } from '../types'
import { imageMimeType } from '../backend'

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const blocked = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]
] satisfies [string, number][]) blocked.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of [
  ['::', 96], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 32], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]
] satisfies [string, number][]) blocked.addSubnet(address, prefix, 'ipv6')

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (!family) return false
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

interface ImageElement {
  type?: string
  attrs?: { src?: unknown }
  children?: readonly ImageElement[]
}

export function extractImageSources(elements: readonly ImageElement[] = []): string[] {
  return elements.flatMap((element) => [
    ...(element.type === 'img' && typeof element.attrs?.src === 'string' ? [element.attrs.src] : []),
    ...extractImageSources(element.children)
  ])
}

/** Each redirect is checked; the validated address is pinned for the connection to prevent DNS rebinding. */
export async function downloadImage(
  ctx: Context, src: string, timeoutMs: number, filenamePrefix = 'image', signal?: AbortSignal
): Promise<GenerateImageInput> {
  signal?.throwIfAborted()
  if (src.startsWith('data:')) {
    if (src.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64) throw new Error('图片大小超过 10 MiB')
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/i.exec(src)
    if (!match) throw new Error('内联图片仅支持 PNG、JPEG、GIF 或 WebP 的 Base64 数据')
    const data = Buffer.from(match[2], 'base64')
    if (data.toString('base64').replace(/=+$/, '') !== match[2].replace(/=+$/, '')) throw new Error('内联图片 Base64 数据无效')
    if (!data.length || data.length > MAX_IMAGE_BYTES) throw new Error('图片为空或超过 10 MiB')
    const mimeType = match[1].toLowerCase()
    return { data, mimeType, filename: `${filenamePrefix}.${mimeType.split('/')[1]}` }
  }
  const controller = new AbortController()
  const dispose = ctx.effect(() => () => controller.abort())
  const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])])
  try {
    let url = new URL(src)
    for (let redirect = 0; redirect <= 5; redirect++) {
      combined.throwIfAborted()
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('图片仅支持无认证的 HTTP(S) 地址')
      const hostname = url.hostname.replace(/^\[|\]$/g, '')
      const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true })
      combined.throwIfAborted()
      if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error('图片地址禁止访问本机或内网')
      const address = addresses[0]
      const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
        const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
          signal: combined,
          headers: { accept: 'image/*' },
          lookup: (_host, options, callback) => {
            if (options.all) callback(null, [address])
            else callback(null, address.address, address.family)
          }
        }, resolve)
        request.on('error', reject)
        request.end()
      })
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
        response.destroy()
        url = new URL(response.headers.location, url)
        continue
      }
      if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
        response.destroy()
        throw new Error(`图片下载失败（${response.statusCode}）`)
      }
      if (Number(response.headers['content-length']) > MAX_IMAGE_BYTES) {
        response.destroy()
        throw new Error('图片大小超过 10 MiB')
      }
      const chunks: Uint8Array[] = []
      let length = 0
      for await (const chunk of response) {
        const bytes: unknown = chunk
        if (!(bytes instanceof Uint8Array)) throw new Error('图片响应格式错误')
        length += bytes.length
        if (length > MAX_IMAGE_BYTES) {
          response.destroy()
          throw new Error('图片大小超过 10 MiB')
        }
        chunks.push(bytes)
      }
      if (!length) throw new Error('图片响应为空')
      const mimeType = imageMimeType(response.headers['content-type'] ?? null, url.href)
      return { data: Buffer.concat(chunks, length), mimeType, filename: `${filenamePrefix}.${mimeType.split('/')[1]}` }
    }
    throw new Error('图片重定向次数过多')
  } finally {
    dispose()
  }
}
