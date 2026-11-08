#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const host = path.resolve(process.env.CHATLUNA_V2_ROOT ?? path.join(source, '../../chatluna-v2-mirror'))
const target = path.join(host, 'external/meme-generator')
const ignored = new Set(['.git', '.claude', 'node_modules', 'lib', 'dist', 'data', 'coverage', '.DS_Store'])
const skip = (relative) => relative.split(path.sep).some((part) => ignored.has(part)) || relative.endsWith('.tsbuildinfo')

if (!fs.existsSync(path.join(host, 'package.json'))) {
  throw new Error(`未找到 ChatLuna v2：${host}，可用 CHATLUNA_V2_ROOT 指定`)
}
if (fs.existsSync(target) && (fs.lstatSync(target).isSymbolicLink() || fs.realpathSync(target) === fs.realpathSync(source))) {
  throw new Error('同步目标不能是源码目录或符号链接')
}

function list(root) {
  const files = new Map()
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      const relative = path.relative(root, absolute)
      if (skip(relative)) continue
      if (entry.isSymbolicLink()) throw new Error(`同步目录包含符号链接：${absolute}`)
      if (entry.isDirectory()) walk(absolute)
      else if (entry.isFile()) files.set(relative, fs.statSync(absolute))
    }
  }
  if (fs.existsSync(root)) walk(root)
  return files
}

function sync() {
  const from = list(source)
  const to = list(target)
  let copied = 0
  let removed = 0
  for (const [relative, stat] of from) {
    const previous = to.get(relative)
    if (previous?.size === stat.size && Math.abs(previous.mtimeMs - stat.mtimeMs) < 1) continue
    const destination = path.join(target, relative)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(path.join(source, relative), destination)
    fs.utimesSync(destination, stat.atime, stat.mtime)
    copied++
  }
  for (const relative of to.keys()) {
    if (from.has(relative)) continue
    fs.rmSync(path.join(target, relative))
    removed++
  }
  console.log(`[sync] 复制 ${copied}，删除 ${removed} → ${target}`)
}

sync()
if (!process.argv.includes('--once')) {
  let timer
  fs.watch(source, { recursive: true }, (_event, filename) => {
    if (filename && skip(String(filename))) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      try {
        sync()
      } catch (error) {
        console.error('[sync] 同步失败', error)
      }
    }, 100)
  })
  console.log(`[sync] 监听 ${source}`)
}
