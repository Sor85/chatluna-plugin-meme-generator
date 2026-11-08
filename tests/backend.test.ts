import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemeBackendClient, imageMimeType, readLimitedBody } from '../src/backend'
import { defaultConfig } from '../src/config'
import { backendFixture, meme, PNG } from './helpers/backend'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

async function setup() {
  const backend = await backendFixture()
  cleanup.push(backend.close)
  return { backend, client: new MemeBackendClient({ ...defaultConfig, baseUrl: `${backend.url}/` }) }
}

describe('Python 后端协议', () => {
  it('真实 HTTP 列表、信息、预览与重复 multipart 字段', async () => {
    const { backend, client } = await setup()
    expect(await client.getKeys()).toEqual(['hello', 'world'])
    expect((await client.getInfo('hello')).keywords).toEqual(['你好'])
    expect(Buffer.from((await client.getPreview('hello')).buffer)).toEqual(PNG)
    const storage = new Uint8Array([9, 1, 2, 3, 9])
    const result = await client.generate('hello', [{ data: storage.subarray(1, 4), filename: 'image.webp', mimeType: 'image/webp' }], ['第一段', '第二段'])
    expect(result.mimeType).toBe('image/png')
    expect(Buffer.from(result.buffer)).toEqual(PNG)
    expect(backend.generated[0].texts).toEqual(['第一段', '第二段'])
    expect(backend.generated[0].args).toBe('{}')
    const image = backend.generated[0].images[0]
    expect(image).toBeInstanceOf(File)
    if (typeof image === 'string') throw new Error('Expected a file')
    expect(image.name).toBe('image.webp')
    expect(image.type).toBe('image/webp')
    expect([...new Uint8Array(await image.arrayBuffer())]).toEqual([1, 2, 3])
  })

  it('按 URL 编码完整模板 key，列表更新不使用过时缓存', async () => {
    const { backend, client } = await setup()
    await client.getKeys()
    backend.templates.set('路径/空 格', meme('路径/空 格'))
    expect(await client.getKeys()).toContain('路径/空 格')
    expect((await client.getInfo('路径/空 格')).key).toBe('路径/空 格')
    await client.generate('路径/空 格', [], ['文字'])
    expect(backend.generated[0].key).toBe('路径/空 格')
  })

  it('错误 detail 优先，不把后端失败作为图片', async () => {
    const { backend, client } = await setup()
    await expect(client.getInfo('missing')).rejects.toThrow('模板不存在')
    backend.failures.set('hello', 541)
    await expect(client.generate('hello', [], [])).rejects.toThrow('模板生成失败')
  })

  it('校验后端结构和 min/max，未配置时给出明确错误', async () => {
    const { backend, client } = await setup()
    backend.templates.set('invalid', meme('invalid', { min_images: 2, max_images: 1 }))
    await expect(client.getInfo('invalid')).rejects.toThrow('参数范围错误')
    const invalid = new MemeBackendClient(defaultConfig)
    await expect(invalid.getKeys()).rejects.toThrow('尚未配置')
    const fetcher: typeof fetch = async () => new Response('{"keys":[]}')
    await expect(new MemeBackendClient({ ...defaultConfig, baseUrl: 'http://fixture' }, fetcher).getKeys()).rejects.toThrow('格式错误')
  })

  it('超时、工具取消和插件卸载会终止请求', async () => {
    const { backend, client } = await setup()
    backend.setDelay(250)
    await expect(new MemeBackendClient({ ...defaultConfig, baseUrl: backend.url, timeoutMs: 20 }).getPreview('hello')).rejects.toThrow('超时')
    const abort = new AbortController()
    const pending = client.getPreview('hello', abort.signal)
    abort.abort(new Error('tool cancelled'))
    await expect(pending).rejects.toThrow('tool cancelled')
    const lifetime = new AbortController()
    const scoped = new MemeBackendClient({ ...defaultConfig, baseUrl: backend.url }, fetch, lifetime.signal)
    lifetime.abort()
    await expect(scoped.getPreview('hello')).rejects.toThrow()
  })
})

describe('图片响应边界', () => {
  it('识别四种 MIME，未知类型回退 PNG', () => {
    expect(imageMimeType('IMAGE/JPEG; charset=utf-8')).toBe('image/jpeg')
    expect(imageMimeType('application/octet-stream')).toBe('image/png')
    expect(imageMimeType(null, 'https://example.test/a.webp?x=1')).toBe('image/webp')
  })
  it('Content-Length 超限取消响应', async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ cancel }), { headers: { 'content-length': '20' } })
    await expect(readLimitedBody(response, 10)).rejects.toThrow('超过')
    expect(cancel).toHaveBeenCalledOnce()
  })
  it('不信任缺失或伪造的 Content-Length，空图片拒绝', async () => {
    const response = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(8)); controller.enqueue(new Uint8Array(8)); controller.close()
    } }), { headers: { 'content-length': '1' } })
    await expect(readLimitedBody(response, 10)).rejects.toThrow('超过')
    await expect(readLimitedBody(new Response(new Uint8Array()), 10)).rejects.toThrow('为空')
  })
})
