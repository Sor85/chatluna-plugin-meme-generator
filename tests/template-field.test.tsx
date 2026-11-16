// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Context } from 'cordis'
import { Schema } from '@chatluna/schema'
import { SchemaForm, extensionOf } from '@chatluna/ui-schema-form/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config } from '../src/config'

const live = vi.hoisted(() => ({
  snapshot: { status: 'ready', data: {
    failed: 0,
    templates: [
      { key: 'hello', name: '你好', detail: 'hello 你好', category: 'text-only' },
      { key: 'hug', name: '抱', detail: 'hug 抱 抱抱', category: 'two-image-only' }
    ]
  } } as Record<string, unknown>,
  callAction: vi.fn(async (_name: string, input: { key: string }) => `data:image/webp;base64,${input.key}`)
}))
vi.mock('@chatluna/ui-client/client', async (original) => ({
  ...await original<object>(),
  useLive: () => live.snapshot,
  callAction: live.callAction
}))

const { default: apply } = await import('../client')
const { TemplateListField } = await import('../client/template-field')

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
})
// jsdom has no layout; every observed preview counts as visible.
vi.stubGlobal('IntersectionObserver', class {
  constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
  observe() { queueMicrotask(() => this.callback([{ isIntersecting: true }])) }
  disconnect() {}
})
afterAll(() => vi.unstubAllGlobals())

const key = 'promptMemeKeys'
const fields: Record<string, Schema> = Object.assign({}, ...(Config.list ?? []).map((group) => group.dict))
const schema = Schema.object({ [key]: fields[key] })
let root: Root | undefined
let container: HTMLDivElement
let dispose: (() => Promise<void>) | undefined

beforeEach(async () => {
  const ctx = new Context()
  await ctx.plugin(apply)
  dispose = () => ctx.fiber.dispose()
})
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  await dispose?.()
  container?.remove()
  live.callAction.mockClear()
})

async function mount(value: Record<string, unknown> = {}) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  let current = value
  function Form() {
    const [draft, setDraft] = useState(value)
    current = draft
    return <SchemaForm schema={schema} value={draft} initial={value} onChange={setDraft} />
  }
  await act(async () => root?.render(<Form />))
  return () => current
}
async function click(element: Element) {
  await act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}
function option(label: string) {
  const element = document.querySelector(`[role="option"][aria-label="${label}"]`)
  if (!element) throw new Error(`缺少模板：${label}`)
  return element
}
async function open() {
  const trigger = [...container.querySelectorAll('button')].find((element) => element.textContent?.includes('选择'))
  if (!trigger) throw new Error('缺少选择按钮')
  await click(trigger)
}

describe('注入模板选择器', () => {
  it('按图文类别分组展示预览网格，勾选后只写入模板 key', async () => {
    const current = await mount()
    expect(container.textContent).toContain('未选择模板')
    await open()
    expect(document.querySelector('[role="group"][aria-label="纯文字"]')?.textContent).toContain('你好')
    expect(document.querySelector('[role="group"][aria-label="双图"]')?.textContent).toContain('抱')
    await act(async () => {})
    expect(option('抱').querySelector('img')?.getAttribute('src')).toBe('data:image/webp;base64,hug')
    await click(option('抱'))
    await click(option('你好'))
    expect(current()[key]).toEqual(['hug', 'hello'])
    await click(option('抱'))
    expect(current()[key]).toEqual(['hello'])
  })

  it('不提供全选，避免把全部模板写入提示', async () => {
    await mount({ [key]: ['hug'] })
    await open()
    expect(option('抱').getAttribute('aria-selected')).toBe('true')
    expect([...document.querySelectorAll('button')].some((element) => element.textContent === '全选')).toBe(false)
  })

  it('已选但目录中不存在的 key 原样显示，预览按 key 只请求一次', async () => {
    await mount({ [key]: ['gone', 'hug'] })
    await act(async () => {})
    expect(container.textContent).toContain('gone')
    expect(container.textContent).toContain('抱')
    await open()
    await act(async () => {})
    // The chip and the grid tile share one request; earlier tests may already have cached it.
    expect(live.callAction.mock.calls.filter(([, input]) => input.key === 'hug').length).toBeLessThanOrEqual(1)
  })

  it('客户端扩展随生命周期注销', async () => {
    expect(extensionOf(fields[key], [])?.component).toBe(TemplateListField)
    await dispose?.()
    dispose = undefined
    expect(extensionOf(fields[key], [])?.component).not.toBe(TemplateListField)
  })
})
