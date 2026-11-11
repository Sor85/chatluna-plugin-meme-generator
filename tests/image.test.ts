import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import { downloadImage, extractImageSources, isPublicAddress } from '../src/utils/image'

describe('图片下载安全边界', () => {
  it.each(['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:192.168.1.1', '2001:db8::1', '64:ff9b::7f00:1'])('拒绝本机、内网和保留地址 %s', (address) => {
    expect(isPublicAddress(address)).toBe(false)
  })
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '198.18.1.84', '198.19.255.1'])('允许公网及代理 fake-ip 地址 %s', (address) => {
    expect(isPublicAddress(address)).toBe(true)
  })
  it('拒绝本地文件、非图片 data URL 和内网目标', async () => {
    const ctx = new Context()
    try {
      for (const src of ['file:///etc/passwd', 'data:text/html;base64,AA==', 'http://127.0.0.1/image.png', 'http://[::1]/image.png']) {
        await expect(downloadImage(ctx, src, 1000)).rejects.toThrow()
      }
    } finally { await ctx.fiber.dispose() }
  })
  it('取消的调用不下载图片', async () => {
    const ctx = new Context()
    try {
      const abort = new AbortController()
      abort.abort(new Error('cancelled'))
      await expect(downloadImage(ctx, 'http://example.invalid/a.png', 1000, 'test', abort.signal)).rejects.toThrow('cancelled')
    } finally { await ctx.fiber.dispose() }
  })
  it('解码平台内联图片，并拒绝非法、空和超大数据', async () => {
    const ctx = new Context()
    try {
      const image = await downloadImage(ctx, 'data:image/png;base64,AQID', 1000)
      expect([...image.data]).toEqual([1, 2, 3])
      expect(image.mimeType).toBe('image/png')
      for (const source of ['data:image/png;base64,', 'data:image/png;base64,!!!!', 'data:image/png;base64,A', 'data:image/svg+xml;base64,AA==']) {
        await expect(downloadImage(ctx, source, 1000)).rejects.toThrow()
      }
      await expect(downloadImage(ctx, `data:image/png;base64,${'A'.repeat(15 * 1024 * 1024)}`, 1000)).rejects.toThrow('超过')
    } finally { await ctx.fiber.dispose() }
  })
  it('递归提取图片，保留输入顺序及重复项', () => {
    expect(extractImageSources([{ type: 'img', attrs: { src: 'first' } }, { children: [{ type: 'img', attrs: { src: 'first' } }, { type: 'img', attrs: { src: 'last' } }] }])).toEqual(['first', 'first', 'last'])
  })
})
