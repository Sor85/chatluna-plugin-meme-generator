#!/usr/bin/env node
// 独立源码目录没有 Yarn workspace 安装状态，因此直接用 Node 启动。
// 正式发布：同步到 v2、清理构建、验证、Yarn 打包、目录发布，确认 npm 版本后推送 Git 标签。
// --dry-run 允许验证未提交改动，不上传 npm、不创建或推送 Git 标签。

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout } from 'node:timers/promises'

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const v2Root = path.resolve(process.env.CHATLUNA_V2_ROOT ?? path.join(source, '../../chatluna-v2-mirror'))
const target = path.join(v2Root, 'external/meme-generator')
const flags = process.argv.slice(2)
const dryRun = flags.includes('--dry-run')
const otp = flags.find((arg) => arg.startsWith('--otp='))

function run(command, args, cwd = source) {
  console.log(`[publish] ${command} ${args.map((arg) => arg.startsWith('--otp=') ? '--otp=[已隐藏]' : arg).join(' ')}`)
  execFileSync(command, args, { cwd, stdio: 'inherit' })
}

function read(command, args) {
  return execFileSync(command, args, { cwd: source, encoding: 'utf8', timeout: 30000 }).trim()
}

function npmView(spec, field) {
  const result = spawnSync('npm', ['view', spec, field, '--json'], { cwd: source, encoding: 'utf8', timeout: 30000 })
  if (result.error) throw result.error
  let value
  try { value = JSON.parse(result.stdout) } catch { throw new Error(`无法解析 npm 对 ${spec} 的查询结果`) }
  if (result.status === 0) return value
  if (value?.error?.code === 'E404') return undefined
  throw new Error(`npm 查询失败：${value?.error?.summary ?? result.stderr.trim()}`)
}

function assertClean() {
  if (read('git', ['status', '--porcelain'])) throw new Error('工作区有未提交的改动；先提交并推送，或使用 --dry-run 演练')
}

async function main() {
  if (flags.includes('--help') || flags.includes('-h')) {
    console.log(`用法：
  node scripts/publish.mjs              发布 package.json 中的版本，并推送 v<版本> 标签
  node scripts/publish.mjs --dry-run    构建、验证、打包及 npm 演练，不实际发布
  node scripts/publish.mjs --otp=<验证码> 传递 npm 两步验证码

宿主默认 ../../chatluna-v2-mirror，可用 CHATLUNA_V2_ROOT 指定。
不自动安装依赖、修改版本、提交源码或推送分支；首次同步或依赖变化后先在宿主执行 yarn install。`)
    return
  }
  for (const arg of flags) {
    if (arg !== '--dry-run' && !/^--otp=.+$/.test(arg)) throw new Error(`不支持的参数：${arg}`)
  }
  if (flags.filter((arg) => arg.startsWith('--otp=')).length > 1) throw new Error('--otp 只能指定一次')
  if (!fs.existsSync(path.join(v2Root, 'package.json'))) throw new Error(`未找到 ChatLuna v2：${v2Root}，可用 CHATLUNA_V2_ROOT 指定`)

  const { name, version } = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'))
  if (!name || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('package.json 缺少有效的包名或版本号')
  const tag = `v${version}`
  const distTag = version.match(/-(alpha|beta|rc|next)/)?.[1] ?? (version.includes('-') ? 'next' : 'latest')
  let head

  if (!dryRun) {
    assertClean()
    const branch = read('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    head = read('git', ['rev-parse', 'HEAD'])
    const remoteHead = read('git', ['ls-remote', 'origin', `refs/heads/${branch}`]).split(/\s/)[0]
    if (head !== remoteHead) throw new Error('当前提交与 origin 同名分支不一致；先确认分支并完成推送')
    if (read('git', ['tag', '--list', tag]) || read('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`])) {
      throw new Error(`Git 标签 ${tag} 已存在；先更新 package.json 的版本号`)
    }
    try { read('npm', ['whoami']) } catch { throw new Error('npm 未登录或当前 registry 不可用；先运行 npm login') }
    if (npmView(`${name}@${version}`, 'version') !== undefined) throw new Error(`npm 版本 ${name}@${version} 已存在；先更新版本号`)
  }

  console.log(`[publish] ${name}@${version} → ${distTag}${dryRun ? '（演练，不上传、不打标签）' : ''}`)
  run(process.execPath, [path.join(source, 'scripts/sync-to-v2.mjs'), '--once'])
  // 同步不删除旧产物；增量信息必须一起清理，否则类型声明可能不会重新生成。
  for (const entry of ['lib', 'dist', 'tsconfig.tsbuildinfo']) fs.rmSync(path.join(target, entry), { recursive: true, force: true })
  run('yarn', ['yakumo', 'build', 'meme-generator'], v2Root)
  run('yarn', ['typecheck'], target)
  run('yarn', ['test'], target)

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'meme-generator-publish-'))
  const tarball = path.join(workdir, 'package.tgz')
  // Yarn 改写 workspace:*；发布解包目录而不是 tgz，保留 npm 的 README 元数据。
  run('yarn', ['pack', '--out', tarball], target)
  run('tar', ['-xzf', tarball, '-C', workdir])
  const packageDir = path.join(workdir, 'package')
  const packed = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
  if (packed.name !== name || packed.version !== version) throw new Error('打包的包名或版本与源码不一致')
  for (const entry of ['lib/index.js', 'lib/index.d.ts', 'dist/client.js', 'README.md', 'LICENSE']) {
    if (!fs.statSync(path.join(packageDir, entry), { throwIfNoEntry: false })?.isFile()) throw new Error(`发布包缺少文件：${entry}`)
  }
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    if (Object.values(packed[field] ?? {}).some((value) => String(value).startsWith('workspace:'))) {
      throw new Error(`发布包的 ${field} 仍含 workspace: 依赖`)
    }
  }
  console.log(`[publish] 包文件：${tarball}，解包目录：${packageDir}`)

  if (!dryRun) {
    assertClean()
    if (read('git', ['rev-parse', 'HEAD']) !== head) throw new Error('构建期间 HEAD 已变更，停止发布')
  }
  const args = ['publish', packageDir, '--access', 'public', '--tag', distTag]
  if (dryRun) args.push('--dry-run')
  if (otp) args.push(otp)
  run('npm', args)
  if (dryRun) {
    console.log('[publish] 演练完成，未上传 npm、未创建或推送 Git 标签')
    return
  }

  // npm 可能先写入暂存版本；索引确认前不打标签，也不报告发布完成。
  let confirmed = false
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      if (npmView(name, 'dist-tags')?.[distTag] === version && npmView(`${name}@${version}`, 'version') === version) {
        confirmed = true
        break
      }
    } catch {
      console.warn('[publish] npm 索引暂时不可查询，等待后重试')
    }
    if (attempt < 14) await setTimeout(2000)
  }
  if (!confirmed) throw new Error(`npm 发布命令已完成，但尚未确认 ${name}@${version} 的 ${distTag} 标签；未创建 Git 标签，先检查 registry，勿直接重复发布`)
  run('git', ['tag', tag, head])
  run('git', ['push', 'origin', tag])
  console.log(`[publish] 已确认发布 ${name}@${version}（${distTag}），Git 标签 ${tag} 已推送`)
}

try {
  await main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  const code = otp?.slice(6)
  console.error(`[publish] ${code ? message.replaceAll(code, '[验证码已隐藏]') : message}`)
  process.exitCode = 1
}
