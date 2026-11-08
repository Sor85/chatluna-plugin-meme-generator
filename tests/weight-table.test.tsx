// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Context } from 'cordis'
import { Schema } from '@chatluna/schema'
import { SchemaForm, extensionOf, registerReactFormExtension } from '@chatluna/ui-schema-form/client'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import apply from '../client'
import { WeightTable } from '../client/weight-table'
import { Config, defaultConfig } from '../src/config'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
// jsdom has no layout engine; popup observers can mount without measuring pixels.
vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
})
afterAll(() => vi.unstubAllGlobals())
let root: Root | undefined
let dispose: (() => void) | undefined
let container: HTMLDivElement
const rulesKey = 'randomMemeBucketWeightRules'
const textKey = 'emptyTextAutoFillRules'
const fields: Record<string, Schema> = Object.assign({}, ...(Config.list ?? []).map((group) => group.dict))
const schema = Schema.object({ [rulesKey]: fields[rulesKey], [textKey]: fields[textKey] })

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  dispose?.()
  dispose = undefined
  container?.remove()
})

async function mount(value: Record<string, unknown> = {}) {
  dispose = registerReactFormExtension({ type: 'array', role: 'meme-generator:weights', component: WeightTable, priority: 30 })
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

function table(name = '随机类别权重') {
  const element = container.querySelector(`table[aria-label="${name}"]`)
  if (!(element instanceof HTMLTableElement)) throw new Error(`缺少表格：${name}`)
  return element
}
function button(label: string) {
  const element = container.querySelector(`button[aria-label="${label}"]`)
  if (!(element instanceof HTMLButtonElement)) throw new Error(`缺少按钮：${label}`)
  return element
}
async function click(element: Element) {
  await act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}
async function input(index: number, value: string) {
  const element = table().querySelectorAll<HTMLInputElement>('input[inputmode="decimal"]')[index]
  if (!(element instanceof HTMLInputElement)) throw new Error('缺少权重输入框')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('权重表格', () => {
  it('在原 SchemaForm 中显示两张紧凑表格，读取默认值不修改配置', async () => {
    const current = await mount()
    expect(table().tBodies[0].rows).toHaveLength(5)
    expect(table('文案来源与权重').tBodies[0].rows).toHaveLength(2)
    expect([...table().tHead!.querySelectorAll('th')].map((cell) => cell.textContent)).toEqual(['类别', '启用', '权重', '操作'])
    expect(table().querySelectorAll('[data-schema-field]')).toHaveLength(0)
    expect(table().querySelectorAll('[role="switch"]')).toHaveLength(5)
    expect(current()).toEqual({})
    expect(container.textContent).toContain('权重（双开来源时用于随机分配）')
    expect(button('上移：仅需文字').disabled).toBe(true)
    expect(button('下移：其他模板').disabled).toBe(true)
  })

  it('修改开关保留其他权重、顺序和未知字段，不原地修改输入', async () => {
    const original = { [rulesKey]: [{ category: 'other', enabled: true, weight: 0, extra: '保留' }] }
    const current = await mount(original)
    await click(table().querySelector('[role="switch"]')!)
    expect(current()[rulesKey]).toEqual([{ category: 'other', enabled: false, weight: 0, extra: '保留' }])
    expect(original[rulesKey][0].enabled).toBe(true)
  })

  it('权重输入和加减按钮继续使用宿主数字控件', async () => {
    const current = await mount({ [rulesKey]: [{ category: 'other', enabled: true, weight: 10 }] })
    await input(0, '60')
    expect(current()[rulesKey]).toEqual([{ category: 'other', enabled: true, weight: 60 }])
    await click(button('增加'))
    expect(current()[rulesKey]).toEqual([{ category: 'other', enabled: true, weight: 61 }])
    await click(button('减少'))
    expect(current()[rulesKey]).toEqual([{ category: 'other', enabled: true, weight: 60 }])
  })

  it('加减按钮遵守权重范围，配置解析拒绝越界值', async () => {
    const current = await mount({ [rulesKey]: [{ category: 'other', enabled: true, weight: 1000 }] })
    await click(button('增加'))
    expect(current()[rulesKey]).toEqual([{ category: 'other', enabled: true, weight: 1000 }])
    await input(0, '0')
    await click(button('减少'))
    expect(current()[rulesKey]).toEqual([{ category: 'other', enabled: true, weight: 0 }])
    await input(0, '-1')
    expect(() => Config(current())).toThrow()
  })

  it('上下移动保持重复类别和各行权重，丢弃数字控件的旧草稿', async () => {
    const current = await mount({ [rulesKey]: [
      { category: 'other', enabled: true, weight: 10 },
      { category: 'other', enabled: false, weight: 20 }
    ] })
    await input(0, '35')
    await click(button('下移：其他模板'))
    expect(current()[rulesKey]).toEqual([
      { category: 'other', enabled: false, weight: 20 },
      { category: 'other', enabled: true, weight: 35 }
    ])
    expect([...table().querySelectorAll<HTMLInputElement>('input[inputmode="decimal"]')].map((element) => element.value)).toEqual(['20', '35'])
    const up = table().querySelectorAll('button[title="上移"]')[1]
    await click(up)
    expect([...table().querySelectorAll<HTMLInputElement>('input[inputmode="decimal"]')].map((element) => element.value)).toEqual(['35', '20'])
  })

  it('允许删除最后一项并保持空数组，新增写入完整默认值', async () => {
    const current = await mount({ [rulesKey]: [{ category: 'other', enabled: true, weight: 0 }] })
    await click(button('删除：其他模板'))
    expect(current()[rulesKey]).toEqual([])
    expect(table().textContent).toContain('暂无规则')
    const field = table().closest('[data-meme-weight-table]')
    const add = [...(field?.querySelectorAll('button') ?? [])].find((item) => item.textContent?.includes('添加一项'))
    if (!add) throw new Error('缺少添加按钮')
    await click(add)
    expect(current()[rulesKey]).toEqual([{ category: 'text-only', enabled: true, weight: 100 }])
    expect(Config(current()).randomMemeBucketWeightRules).toHaveLength(1)
  })

  it('保存后的值重新打开仍保持原有权重、顺序和开关', async () => {
    const value = { [rulesKey]: [
      { category: 'two-image-only', enabled: true, weight: 60 },
      { category: 'text-only', enabled: false, weight: 0 }
    ] }
    await mount(value)
    expect([...table().querySelectorAll<HTMLInputElement>('input[inputmode="decimal"]')].map((element) => element.value)).toEqual(['60', '0'])
    expect([...table().querySelectorAll('[role="switch"]')].map((element) => element.getAttribute('aria-checked'))).toEqual(['true', 'false'])
    expect(table().textContent?.indexOf('需 2 张图片')).toBeLessThan(table().textContent?.indexOf('仅需文字') ?? 0)
  })

  it('类别下拉沿用宿主选项，选择后保留同行开关和权重', async () => {
    const current = await mount({ [rulesKey]: [{ category: 'other', enabled: false, weight: 60 }] })
    await click(table().querySelector('[role="combobox"]')!)
    const option = [...document.querySelectorAll('[role="option"]')].find((element) => element.textContent?.includes('仅需文字'))
    if (!option) throw new Error('缺少类别选项')
    await act(async () => option.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', buttons: 1 })))
    await click(option)
    expect(current()[rulesKey]).toEqual([{ category: 'text-only', enabled: false, weight: 60 }])
  })

  it('整组恢复默认仍由宿主菜单处理，不清空另一组配置', async () => {
    const original = { [rulesKey]: [{ category: 'other', enabled: false, weight: 60 }], [textKey]: [] }
    const current = await mount(original)
    await click(button('随机类别权重更多操作'))
    const restore = [...document.querySelectorAll('[role="menuitem"]')].find((element) => element.textContent?.includes('恢复默认'))
    if (!restore) throw new Error('缺少恢复默认菜单')
    await click(restore)
    expect(current()[rulesKey]).toBeUndefined()
    expect(current()[textKey]).toEqual([])
    expect(table().tBodies[0].rows).toHaveLength(5)
    expect([...table().querySelectorAll<HTMLInputElement>('input[inputmode="decimal"]')].map((element) => element.value)).toEqual(['100', '100', '100', '100', '100'])
  })

  it('数组专属扩展随客户端生命周期注销，不影响普通 table role', async () => {
    const ordinary = Schema.array(Schema.object({ weight: Schema.number() })).role('table')
    const before = extensionOf(ordinary, [])?.component
    const ctx = new Context()
    await ctx.plugin(apply)
    try {
      expect(extensionOf(fields[rulesKey], defaultConfig.randomMemeBucketWeightRules)?.component).toBe(WeightTable)
      expect(extensionOf(ordinary, [])?.component).toBe(before)
    } finally {
      await ctx.fiber.dispose()
    }
    expect(extensionOf(fields[rulesKey], [])?.component).not.toBe(WeightTable)
  })
})
