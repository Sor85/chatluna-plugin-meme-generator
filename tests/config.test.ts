import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Config, defaultConfig } from '../src/config'

describe('配置与项目说明', () => {
  it('默认配置与八组设置一致，所有字段有中文标签', () => {
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
  it('只有两组权重数组使用插件专属表格角色', () => {
    const fields = Object.fromEntries((Config.list ?? []).flatMap((group) => Object.entries(group.dict ?? {})))
    expect(fields.randomMemeBucketWeightRules.meta.role).toBe('meme-generator:weights')
    expect(fields.emptyTextAutoFillRules.meta.role).toBe('meme-generator:weights')
    expect(fields.excludedMemeKeys.meta.role).toBe('table')
    expect(fields.groupExcludedMemeKeys.meta.role).toBe('table')
  })
  it('无前缀模板键默认开启，显式关闭值保持不变', () => {
    const fields = Object.fromEntries((Config.list ?? []).flatMap((group) => Object.entries(group.dict ?? {})))
    expect(defaultConfig.allowKeyWithoutPrefixTrigger).toBe(true)
    expect(fields.allowKeyWithoutPrefixTrigger.meta.default).toBe(true)
    expect(Config({}).allowKeyWithoutPrefixTrigger).toBe(true)
    expect(Config({ allowKeyWithoutPrefixTrigger: false }).allowKeyWithoutPrefixTrigger).toBe(false)
  })
  it('不再提供动作参考提示词，旧配置仍能加载原生工具', () => {
    const fields = Object.fromEntries((Config.list ?? []).flatMap((group) => Object.entries(group.dict ?? {})))
    expect(fields).not.toHaveProperty('memeXmlReferencePrompt')
    expect(defaultConfig).not.toHaveProperty('memeXmlReferencePrompt')
    expect(Config({})).not.toHaveProperty('memeXmlReferencePrompt')
    expect(Config({ memeXmlReferencePrompt: '旧版参考文本', enableMemeXmlTool: true }).enableMemeXmlTool).toBe(true)
    expect(fields.enableMemeXmlTool).toBeDefined()
  })
  it('仅保留关键词检索缓存配置，不提供嵌入模型或阈值选项', () => {
    const fields = Object.fromEntries((Config.list ?? []).flatMap((group) => Object.entries(group.dict ?? {})))
    for (const name of ['memeSearchEmbeddingModel', 'memeSearchSemanticThreshold']) {
      expect(fields).not.toHaveProperty(name)
      expect(defaultConfig).not.toHaveProperty(name)
      expect(Config({})).not.toHaveProperty(name)
    }
    expect(Config({}).memeSearchCacheMinutes).toBe(30)
    expect(() => Config({ memeSearchCacheMinutes: 0 })).toThrow()
    expect(() => Config({ memeSearchCacheMinutes: 1441 })).toThrow()
  })
  it('动作跨会话并发默认为 4，仅接受 1–16 的整数', () => {
    expect(Config({}).memeActionConcurrency).toBe(4)
    expect(Config({ memeActionConcurrency: 1 }).memeActionConcurrency).toBe(1)
    expect(Config({ memeActionConcurrency: 16 }).memeActionConcurrency).toBe(16)
    for (const value of [0, 17, 1.5]) expect(() => Config({ memeActionConcurrency: value })).toThrow()
  })
  it('动作排队期限和数量具有独立默认值及范围', () => {
    expect(Config({}).memeActionQueueTimeoutSeconds).toBe(30)
    expect(Config({}).memeActionQueueLimit).toBe(5)
    for (const value of [0, 301, 1.5]) expect(() => Config({ memeActionQueueTimeoutSeconds: value })).toThrow()
    for (const value of [0, 21, 1.5]) expect(() => Config({ memeActionQueueLimit: value })).toThrow()
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
