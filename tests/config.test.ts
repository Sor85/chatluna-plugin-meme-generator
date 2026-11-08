import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Config, defaultConfig } from '../src/config'

describe('配置与项目说明', () => {
  it('保留迁移基线默认值与八组设置，所有字段有中文标签', () => {
    expect(Config({})).toEqual(defaultConfig)
    expect(Config.list).toHaveLength(8)
    for (const group of Config.list ?? []) {
      for (const field of Object.values(group.dict ?? {})) {
        expect(field.meta.label).toBeTruthy()
        expect(typeof field.meta.description).toBe('string')
        expect(field.meta.description).not.toContain('是否')
      }
    }
    expect(defaultConfig.enableMemeXmlTool).toBe(false)
    expect(defaultConfig.randomDedupeWindowHours).toBe(24)
    expect(defaultConfig.emptyTextAutoFillRules.map((rule) => rule.weight)).toEqual([100, 100])
    expect(defaultConfig.randomMemeBucketWeightRules).toHaveLength(5)
  })
  it('规则数组整体替换，拒绝非法范围', () => {
    expect(Config({ emptyTextAutoFillRules: [] }).emptyTextAutoFillRules).toEqual([])
    expect(Config({ randomMemeBucketWeightRules: [] }).randomMemeBucketWeightRules).toEqual([])
    expect(() => Config({ timeoutMs: 1 })).toThrow()
    expect(() => Config({ randomDedupeWindowHours: 721 })).toThrow()
    expect(() => Config({ randomMemeBucketWeightRules: [{ category: 'other', enabled: true, weight: -1 }] })).toThrow()
  })
  it('根说明登记全部子目录说明且没有失效路径', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const entry = readFileSync(join(root, 'AGENTS.md'), 'utf8')
    const listed = [...entry.matchAll(/`([^`]+\/AGENTS\.md)`/g)].map((match) => match[1]).sort()
    const actual: string[] = []
    const skip = new Set(['node_modules', 'lib', 'dist', '.git', '.claude', 'coverage', 'data'])
    function scan(directory: string) {
      for (const item of readdirSync(directory, { withFileTypes: true })) {
        if (skip.has(item.name)) continue
        const full = join(directory, item.name)
        if (item.isDirectory()) scan(full)
        else if (item.name === 'AGENTS.md' && directory !== root) actual.push(relative(root, full).replaceAll('\\', '/'))
      }
    }
    scan(root)
    expect(listed).toEqual(actual.sort())
  })
})
