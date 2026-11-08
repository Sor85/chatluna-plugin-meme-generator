import type { Session } from '@satorijs/core'

type ConversationIdentity = Pick<Session, 'platform' | 'selfId' | 'isDirect' | 'guildId' | 'channelId' | 'userId'>

export function memeConversationKey(session: ConversationIdentity): string {
  const { platform, selfId, isDirect, guildId, channelId, userId } = session
  const scope = isDirect ? 'direct' : channelId ? 'channel' : 'guild'
  const target = isDirect ? userId : channelId || guildId
  if (!platform || !selfId || !target) throw new Error('meme 动作无法确定平台会话')
  // Structured fields avoid delimiter collisions and keep same-named channels in different guilds separate.
  return JSON.stringify([platform, selfId, scope, guildId ?? '', target])
}

interface QueueLimits {
  maxWaitMs: number
  maxPendingPerConversation: number
  maxPendingTotal: number
}
interface Job {
  signal: AbortSignal
  expiresAt: number
  work(): Promise<void>
  resolve(): void
  reject(reason: unknown): void
  cancel(): void
  cleanup(): void
}

export class MemeActionQueue {
  private waiting = new Map<string, Job[]>()
  private running = new Set<string>()
  private limits: QueueLimits

  constructor(private limit: number, limits: Partial<QueueLimits> = {}) {
    this.limits = { maxWaitMs: 30000, maxPendingPerConversation: 5, maxPendingTotal: 100, ...limits }
    if ([limit, ...Object.values(this.limits)].some((value) => !Number.isInteger(value) || value < 1)) {
      throw new Error('动作并发及排队限制必须为正整数')
    }
  }

  run(key: string, signal: AbortSignal, work: () => Promise<void>): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason)
    const jobs = this.waiting.get(key) ?? []
    const canStart = !jobs.length && !this.running.has(key) && this.running.size < this.limit
    if (!canStart) {
      if (jobs.length >= this.limits.maxPendingPerConversation) {
        return Promise.reject(new Error(`当前会话待处理的表情动作达到上限（${this.limits.maxPendingPerConversation} 条）`))
      }
      const total = [...this.waiting.values()].reduce((sum, items) => sum + items.length, 0)
      if (total >= this.limits.maxPendingTotal) {
        return Promise.reject(new Error(`表情动作等待队列已满（${this.limits.maxPendingTotal} 条）`))
      }
    }
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const fail = (reason: unknown) => {
        const pending = this.waiting.get(key)
        const index = pending?.indexOf(job) ?? -1
        if (!pending || index < 0) return
        pending.splice(index, 1)
        if (!pending.length) this.waiting.delete(key)
        job.cleanup()
        reject(reason)
        this.drain()
      }
      const job: Job = {
        signal, work, resolve, reject,
        expiresAt: Date.now() + this.limits.maxWaitMs,
        cancel: () => fail(signal.reason),
        cleanup: () => {
          if (timer !== undefined) clearTimeout(timer)
          signal.removeEventListener('abort', job.cancel)
        }
      }
      jobs.push(job)
      this.waiting.set(key, jobs)
      timer = setTimeout(() => fail(this.timeoutError()), this.limits.maxWaitMs)
      timer.unref()
      signal.addEventListener('abort', job.cancel, { once: true })
      if (signal.aborted) job.cancel()
      this.drain()
    })
  }

  private timeoutError() {
    return new Error(`表情动作排队超时（${this.limits.maxWaitMs / 1000} 秒），已取消`)
  }

  private drain() {
    while (this.running.size < this.limit) {
      const next = [...this.waiting].find(([key]) => !this.running.has(key))
      if (!next) return
      const [key, jobs] = next
      const job = jobs.shift()
      if (!jobs.length) this.waiting.delete(key)
      if (!job) continue
      job.cleanup()
      if (job.signal.aborted) { job.reject(job.signal.reason); continue }
      if (Date.now() >= job.expiresAt) { job.reject(this.timeoutError()); continue }
      this.running.add(key)
      queueMicrotask(() => { void this.execute(key, job) })
    }
  }

  private async execute(key: string, job: Job) {
    try {
      job.signal.throwIfAborted()
      // A stalled event loop may resume this microtask after its admission deadline.
      if (Date.now() >= job.expiresAt) throw this.timeoutError()
      await job.work()
      job.resolve()
    } catch (error) {
      job.reject(error)
    } finally {
      this.running.delete(key)
      // A busy conversation joins the end again rather than starving conversations already waiting.
      const remaining = this.waiting.get(key)
      if (remaining) {
        this.waiting.delete(key)
        this.waiting.set(key, remaining)
      }
      this.drain()
    }
  }
}
