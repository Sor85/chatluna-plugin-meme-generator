import { createServer } from 'node:http'
import { crc32, deflateSync } from 'node:zlib'
import type { MemeInfoResponse } from '../../src/types'

export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR1cAAAAASUVORK5CYII=', 'base64')
/** A decodable 2×2 RGBA PNG; `PNG` above only has to look like an image, this one has to render. */
export function validPng() {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(2, 0)
  header.writeUInt32BE(2, 4)
  header.set([8, 6, 0, 0, 0], 8)
  const row = Buffer.from([0, 255, 0, 0, 255, 0, 0, 255, 255])
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat([row, row]))), chunk('IEND', Buffer.alloc(0))
  ])
}
export function meme(key: string, overrides: Partial<MemeInfoResponse['params_type']> = {}, keywords = [key]): MemeInfoResponse {
  return { key, keywords, shortcuts: [], tags: [], date_created: '', date_modified: '', params_type: {
    min_images: 0, max_images: 0, min_texts: 1, max_texts: 2, default_texts: ['默认文字'], ...overrides
  } }
}

export async function backendFixture(initial = [meme('hello', {}, ['你好']), meme('world', {}, ['世界'])]) {
  const templates = new Map(initial.map((info) => [info.key, info]))
  const generated: { key: string; texts: FormDataEntryValue[]; images: FormDataEntryValue[]; args: FormDataEntryValue | null }[] = []
  const failures = new Map<string, number>()
  const barriers = new Map<string, { entered(): void; wait: Promise<void>; release(): void }>()
  let delay = 0
  let preview: Buffer | undefined
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://fixture')
      const parts = url.pathname.split('/')
      const key = decodeURIComponent(parts[2] ?? '')
      if (url.pathname === '/memes/keys') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify([...templates.keys()]))
        return
      }
      const info = templates.get(key)
      if (!info) {
        res.writeHead(531, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ detail: '模板不存在' }))
        return
      }
      if (parts[3] === 'info') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(info))
        return
      }
      if (req.method === 'POST') {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const request = new Request('http://fixture', {
          method: 'POST', headers: { 'content-type': req.headers['content-type'] ?? '' },
          body: new Blob(chunks.map((chunk) => new Uint8Array(chunk)))
        })
        const form = await request.formData()
        generated.push({ key, texts: form.getAll('texts'), images: form.getAll('images'), args: form.get('args') })
        const barrier = barriers.get(key)
        if (barrier) { barrier.entered(); await barrier.wait }
        if (res.destroyed) return
        if (failures.has(key)) {
          res.writeHead(failures.get(key) ?? 500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ detail: '模板生成失败' }))
          return
        }
      }
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
      if (res.destroyed) return
      res.setHeader('content-type', 'image/png; charset=binary')
      res.end(parts[3] === 'preview' && preview ? preview : PNG)
    })().catch((error: unknown) => {
      if (res.destroyed) return
      res.writeHead(500)
      res.end(String(error))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind a TCP port')
  return {
    url: `http://127.0.0.1:${address.port}`, templates, generated, failures,
    setDelay(ms: number) { delay = ms },
    setPreview(image: Buffer) { preview = image },
    blockGeneration(key: string) {
      const started = Promise.withResolvers<void>()
      const gate = Promise.withResolvers<void>()
      const barrier = { entered: started.resolve, wait: gate.promise, release: gate.resolve }
      barriers.set(key, barrier)
      return {
        started: started.promise,
        release() {
          if (barriers.get(key) === barrier) barriers.delete(key)
          gate.resolve()
        }
      }
    },
    async close() {
      for (const barrier of barriers.values()) barrier.release()
      barriers.clear()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  }
}
