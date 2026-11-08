import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }) })

interface Options {
  dirty?: boolean
  ahead?: boolean
  localTag?: boolean
  remoteTag?: boolean
  npmExists?: boolean
  fail?: string
  stage?: boolean
  workspace?: boolean
  missingTypes?: boolean
  version?: string
  distTag?: string
}
interface Call { command: string; args: string[]; cwd: string }

// CLI 替身只写隔离目录；不执行真实 Git 操作、npm 上传或递归启动测试。
const cli = String.raw`
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const command = path.basename(process.argv[1])
const args = process.argv.slice(2)
const config = JSON.parse(fs.readFileSync(process.env.PUBLISH_TEST_CONFIG, 'utf8'))
const output = value => process.stdout.write(value + '\n')
const json = value => output(JSON.stringify(value))
const log = { command, args, cwd: process.cwd() }
fs.appendFileSync(process.env.PUBLISH_TEST_LOG, JSON.stringify(log) + '\n')
const phase = process.env.PUBLISH_TEST_CONFIG + '.published'
const version = config.version || '0.0.1'
const tag = config.distTag || 'latest'
if (command === 'git') {
  if (args[0] === 'status') output(config.dirty ? ' M src/index.ts' : '')
  else if (args[0] === 'symbolic-ref') output('main')
  else if (args[0] === 'rev-parse') output('a'.repeat(40))
  else if (args[0] === 'tag' && args[1] === '--list') output(config.localTag ? 'v' + version : '')
  else if (args[0] === 'ls-remote') {
    if (args.includes('--tags')) output(config.remoteTag ? 'a'.repeat(40) + '\trefs/tags/v' + version : '')
    else output((config.ahead ? 'b' : 'a').repeat(40) + '\trefs/heads/main')
  }
} else if (command === 'npm') {
  if (args[0] === 'whoami') output('test-user')
  else if (args[0] === 'view') {
    if (args[2] === 'dist-tags') {
      const count = Number(fs.readFileSync(phase, 'utf8'))
      fs.writeFileSync(phase, String(count + 1))
      json({ [tag]: config.stage && count === 0 ? '0.0.0-stage' : version })
    } else if (config.npmExists || fs.existsSync(phase)) json(version)
    else { json({ error: { code: 'E404' } }); process.exitCode = 1 }
  } else if (args[0] === 'publish') {
    if (!fs.existsSync(path.join(args[1], 'README.md'))) process.exit(12)
    if (config.fail === 'publish') process.exit(13)
    if (!args.includes('--dry-run')) fs.writeFileSync(phase, '0')
  }
} else if (command === 'yarn') {
  if (args[0] === 'yakumo') {
    if (config.fail === 'build') process.exit(14)
    const target = path.join(process.cwd(), 'external/meme-generator')
    for (const stale of ['lib/stale.d.ts', 'dist/stale.js', 'tsconfig.tsbuildinfo']) {
      if (fs.existsSync(path.join(target, stale))) process.exit(15)
    }
    for (const entry of ['lib/index.js', 'lib/index.d.ts', 'dist/client.js']) {
      if (config.missingTypes && entry.endsWith('.d.ts')) continue
      const file = path.join(target, entry)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, '// fresh build')
    }
  } else if (args[0] === 'typecheck' || args[0] === 'test') {
    if (config.fail === args[0]) process.exit(16)
  } else if (args[0] === 'pack') {
    const out = args[args.indexOf('--out') + 1]
    const staging = fs.mkdtempSync(path.join(path.dirname(out), 'pack-'))
    const destination = path.join(staging, 'package')
    fs.mkdirSync(destination)
    for (const entry of ['lib', 'dist', 'README.md', 'LICENSE']) {
      fs.cpSync(path.join(process.cwd(), entry), path.join(destination, entry), { recursive: true })
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'))
    if (!config.workspace) manifest.devDependencies['@chatluna/chat'] = '2.0.0-alpha.1'
    fs.writeFileSync(path.join(destination, 'package.json'), JSON.stringify(manifest))
    execFileSync('tar', ['-czf', out, '-C', staging, 'package'])
    fs.rmSync(staging, { recursive: true })
  }
}
`

function setup(options: Options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meme-publish-test-'))
  directories.push(directory)
  const source = path.join(directory, 'source')
  const host = path.join(directory, 'host')
  const target = path.join(host, 'external/meme-generator')
  const bin = path.join(directory, 'bin')
  const temporary = path.join(directory, 'tmp')
  for (const folder of [path.join(source, 'scripts'), target, bin, temporary]) fs.mkdirSync(folder, { recursive: true })
  const manifest = { name: 'chatluna-plugin-meme-generator', version: options.version ?? '0.0.1', type: 'module', devDependencies: { '@chatluna/chat': 'workspace:*' } }
  for (const folder of [source, target]) fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify(manifest))
  fs.writeFileSync(path.join(host, 'package.json'), '{}')
  for (const entry of ['README.md', 'LICENSE', 'data/keep.txt', 'node_modules/keep.txt', 'lib/stale.d.ts', 'dist/stale.js', 'tsconfig.tsbuildinfo']) {
    fs.mkdirSync(path.dirname(path.join(target, entry)), { recursive: true })
    fs.writeFileSync(path.join(target, entry), entry)
  }
  const script = path.join(source, 'scripts/publish.mjs')
  fs.copyFileSync(fileURLToPath(new URL('../scripts/publish.mjs', import.meta.url)), script)
  fs.writeFileSync(path.join(source, 'scripts/sync-to-v2.mjs'), `import fs from 'node:fs'; fs.appendFileSync(process.env.PUBLISH_TEST_LOG, JSON.stringify({ command: 'sync', args: process.argv.slice(2), cwd: process.cwd() }) + '\\n')`)
  for (const command of ['git', 'yarn', 'npm']) fs.writeFileSync(path.join(bin, command), `#!${process.execPath}\n${cli}`, { mode: 0o755 })
  const config = path.join(directory, 'config.json')
  const log = path.join(directory, 'calls.jsonl')
  fs.writeFileSync(config, JSON.stringify(options))
  fs.writeFileSync(log, '')
  return {
    source, target,
    run(...args: string[]) {
      const result = spawnSync(process.execPath, [script, ...args], {
        cwd: directory, encoding: 'utf8', timeout: 15000,
        env: { ...process.env, NODE_OPTIONS: '', PATH: `${bin}${path.delimiter}${process.env.PATH}`, CHATLUNA_V2_ROOT: host, TMPDIR: temporary, TMP: temporary, TEMP: temporary, PUBLISH_TEST_CONFIG: config, PUBLISH_TEST_LOG: log }
      })
      const calls: Call[] = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      return { ...result, calls, output: `${result.stdout}\n${result.stderr}` }
    }
  }
}

describe('独立 Node 发布脚本', () => {
  it('帮助和非法参数不触发任何发布流程', () => {
    const app = setup()
    expect(app.run('--help').status).toBe(0)
    const invalid = app.run('--unknown')
    expect(invalid.status).toBe(1)
    expect(invalid.calls).toEqual([])
  })

  it('演练允许脏工作区，清理后完整验证并从解包目录演练发布', () => {
    const app = setup({ dirty: true })
    const result = app.run('--dry-run')
    expect(result.status, result.output).toBe(0)
    expect(result.calls.map((call) => [call.command, call.args[0]])).toEqual([
      ['sync', '--once'], ['yarn', 'yakumo'], ['yarn', 'typecheck'], ['yarn', 'test'], ['yarn', 'pack'], ['npm', 'publish']
    ])
    const publish = result.calls.at(-1)
    expect(publish?.args).toContain('--dry-run')
    expect(publish?.args[1]).toMatch(/[/\\]package$/)
    expect(fs.readFileSync(path.join(app.target, 'data/keep.txt'), 'utf8')).toBe('data/keep.txt')
    expect(fs.readFileSync(path.join(app.target, 'node_modules/keep.txt'), 'utf8')).toBe('node_modules/keep.txt')
  })

  it.each<Options>([{ dirty: true }, { ahead: true }, { localTag: true }, { remoteTag: true }, { npmExists: true }])('正式发布前拒绝不满足条件的状态：%j', (options) => {
    const result = setup(options).run()
    expect(result.status, result.output).toBe(1)
    expect(result.calls.some((call) => call.command === 'sync')).toBe(false)
    expect(result.calls.some((call) => call.args[0] === 'publish' || call.args[0] === 'push')).toBe(false)
  })

  it.each<Options>([{ fail: 'build' }, { fail: 'typecheck' }, { fail: 'test' }, { workspace: true }, { missingTypes: true }])('验证或包检查失败时不调用 npm publish：%j', (options) => {
    const result = setup(options).run('--dry-run')
    expect(result.status, result.output).toBe(1)
    expect(result.calls.some((call) => call.command === 'npm' && call.args[0] === 'publish')).toBe(false)
  })

  it('正式发布等待 npm 标签和版本确认后才创建并推送 Git 标签', () => {
    const result = setup({ stage: true }).run('--otp=123456')
    expect(result.status, result.output).toBe(0)
    expect(result.output).not.toContain('123456')
    expect(result.calls.find((call) => call.command === 'npm' && call.args[0] === 'publish')?.args).toContain('--otp=123456')
    expect(result.calls.filter((call) => call.command === 'npm' && call.args[2] === 'dist-tags')).toHaveLength(2)
    expect(result.calls.slice(-2).map((call) => call.args)).toEqual([['tag', 'v0.0.1', 'a'.repeat(40)], ['push', 'origin', 'v0.0.1']])
  })

  it('预发布使用相应 npm 标签而非 latest', () => {
    const result = setup({ version: '0.0.2-beta.1', distTag: 'beta' }).run()
    expect(result.status, result.output).toBe(0)
    const args = result.calls.find((call) => call.command === 'npm' && call.args[0] === 'publish')?.args ?? []
    expect(args[args.indexOf('--tag') + 1]).toBe('beta')
    expect(result.calls.at(-1)?.args).toEqual(['push', 'origin', 'v0.0.2-beta.1'])
  })

  it('npm 发布失败不打标签，日志不泄露验证码', () => {
    const result = setup({ fail: 'publish' }).run('--otp=123456')
    expect(result.status).toBe(1)
    expect(result.output).not.toContain('123456')
    expect(result.calls.some((call) => call.command === 'git' && (call.args[0] === 'push' || call.args[0] === 'tag' && call.args[1] !== '--list'))).toBe(false)
  })
})
