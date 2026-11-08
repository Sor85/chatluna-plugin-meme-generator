import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemeActionQueue, memeConversationKey } from '../src/action-queue'

const signal = () => new AbortController().signal
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('表情动作会话队列', () => {
  it('会话键稳定，区分平台、机器人、群和私聊而不使用消息或 agent 标识', () => {
    const base = { platform: 'onebot', selfId: 'bot', isDirect: false, guildId: 'guild', channelId: 'room', userId: 'alice' }
    const key = memeConversationKey(base)
    expect(memeConversationKey({ ...base, userId: 'bob' })).toBe(key)
    for (const changed of [
      { ...base, platform: 'other' }, { ...base, selfId: 'other' },
      { ...base, guildId: 'other' }, { ...base, channelId: 'other' },
      { ...base, isDirect: true }
    ]) expect(memeConversationKey(changed)).not.toBe(key)
    expect(memeConversationKey({ ...base, isDirect: true, userId: 'alice' })).not.toBe(memeConversationKey({ ...base, isDirect: true, userId: 'bob' }))
    expect(memeConversationKey({ ...base, platform: 'one:two', selfId: 'three' })).not.toBe(memeConversationKey({ ...base, platform: 'one', selfId: 'two:three' }))
  })

  it('缺少会话目标时拒绝，不回退到共享全局队列', () => {
    const base = { platform: 'onebot', selfId: 'bot', isDirect: false, guildId: 'guild', channelId: undefined, userId: 'alice' }
    expect(memeConversationKey(base)).not.toBe(memeConversationKey({ ...base, guildId: 'other' }))
    expect(() => memeConversationKey({ ...base, guildId: undefined })).toThrow('无法确定')
    expect(() => memeConversationKey({ ...base, isDirect: true, userId: undefined })).toThrow('无法确定')
    expect(() => new MemeActionQueue(0)).toThrow()
    expect(() => new MemeActionQueue(1.5)).toThrow()
  })

  it('同一会话串行，慢会话不阻塞其他会话', async () => {
    const queue = new MemeActionQueue(2)
    const gate = Promise.withResolvers<void>()
    const started: string[] = []
    const first = queue.run('a', signal(), async () => { started.push('a1'); await gate.promise })
    const second = queue.run('a', signal(), async () => { started.push('a2') })
    const other = queue.run('b', signal(), async () => { started.push('b1') })
    try {
      await other
      expect(started).toEqual(['a1', 'b1'])
    } finally { gate.resolve() }
    await Promise.all([first, second])
    expect(started).toEqual(['a1', 'b1', 'a2'])
  })

  it('跨会话并发不超过上限，空闲后继续处理排队动作', async () => {
    const queue = new MemeActionQueue(2)
    const gates = Array.from({ length: 5 }, () => Promise.withResolvers<void>())
    const started: number[] = []
    let active = 0
    let peak = 0
    const tasks = gates.map((gate, index) => queue.run(String(index), signal(), async () => {
      started.push(index)
      peak = Math.max(peak, ++active)
      try { await gate.promise } finally { active-- }
    }))
    try {
      await vi.waitFor(() => expect(started).toEqual([0, 1]))
      gates[0].resolve()
      await vi.waitFor(() => expect(started).toEqual([0, 1, 2]))
      expect(peak).toBe(2)
    } finally { gates.forEach((gate) => gate.resolve()) }
    await Promise.all(tasks)
    expect(peak).toBe(2)
    expect(active).toBe(0)
  })

  it('繁忙会话的后续动作让位于已经等待的其他会话', async () => {
    const queue = new MemeActionQueue(1)
    const gate = Promise.withResolvers<void>()
    const order: string[] = []
    const first = queue.run('a', signal(), async () => { order.push('a1'); await gate.promise })
    const second = queue.run('a', signal(), async () => { order.push('a2') })
    const other = queue.run('b', signal(), async () => { order.push('b1') })
    gate.resolve()
    await Promise.all([first, second, other])
    expect(order).toEqual(['a1', 'b1', 'a2'])
  })

  it('取消排队动作立即移除，不运行也不阻塞后续同会话动作', async () => {
    const queue = new MemeActionQueue(1)
    const gate = Promise.withResolvers<void>()
    const controller = new AbortController()
    const cancelledWork = vi.fn(async () => {})
    const first = queue.run('a', signal(), () => gate.promise)
    const cancelled = queue.run('a', controller.signal, cancelledWork)
    const rejected = expect(cancelled).rejects.toThrow('取消排队')
    const after = vi.fn(async () => {})
    const next = queue.run('a', signal(), after)
    try {
      controller.abort(new Error('取消排队'))
      await rejected
      expect(cancelledWork).not.toHaveBeenCalled()
      expect(after).not.toHaveBeenCalled()
    } finally { gate.resolve() }
    await Promise.all([first, next])
    expect(after).toHaveBeenCalledTimes(1)
  })

  it('排队会话全部取消后可再次使用同一会话键', async () => {
    const queue = new MemeActionQueue(1)
    const gate = Promise.withResolvers<void>()
    const first = queue.run('a', signal(), () => gate.promise)
    const controller = new AbortController()
    const work = vi.fn(async () => {})
    const cancelled = queue.run('b', controller.signal, work)
    const rejected = expect(cancelled).rejects.toThrow('移除会话')
    controller.abort(new Error('移除会话'))
    await rejected
    const next = queue.run('b', signal(), work)
    gate.resolve()
    await Promise.all([first, next])
    expect(work).toHaveBeenCalledTimes(1)
  })

  it('失败释放执行槽，且不影响同会话后续动作', async () => {
    const queue = new MemeActionQueue(1)
    const failed = queue.run('a', signal(), async () => { throw new Error('生成失败') })
    const rejected = expect(failed).rejects.toThrow('生成失败')
    const work = vi.fn(async () => {})
    const next = queue.run('a', signal(), work)
    await rejected
    await next
    expect(work).toHaveBeenCalledTimes(1)
  })

  it('运行中取消不会提前释放仍被任务占用的槽', async () => {
    const queue = new MemeActionQueue(1)
    const gate = Promise.withResolvers<void>()
    const controller = new AbortController()
    const started = vi.fn()
    const first = queue.run('a', controller.signal, async () => { started(); await gate.promise })
    await vi.waitFor(() => expect(started).toHaveBeenCalled())
    const other = vi.fn(async () => {})
    const next = queue.run('b', signal(), other)
    controller.abort()
    expect(other).not.toHaveBeenCalled()
    gate.resolve()
    await Promise.all([first, next])
    expect(other).toHaveBeenCalledTimes(1)
  })

  it('排队超时立即失败并回收容量，之后不再执行过期动作', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const queue = new MemeActionQueue(1, { maxWaitMs: 1000, maxPendingPerConversation: 1 })
    const gate = Promise.withResolvers<void>()
    const first = queue.run('a', signal(), () => gate.promise)
    const expiredWork = vi.fn(async () => {})
    const expired = queue.run('b', signal(), expiredWork)
    const rejected = expect(expired).rejects.toThrow('排队超时')
    await vi.advanceTimersByTimeAsync(1000)
    await rejected
    expect(expiredWork).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    const nextWork = vi.fn(async () => {})
    const next = queue.run('b', signal(), nextWork)
    gate.resolve()
    await Promise.all([first, next])
    await vi.advanceTimersByTimeAsync(5000)
    expect(expiredWork).not.toHaveBeenCalled()
    expect(nextWork).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('开始执行后清除排队计时器，不把等待时限当作执行时限', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const queue = new MemeActionQueue(1, { maxWaitMs: 1000 })
    const firstGate = Promise.withResolvers<void>()
    const secondGate = Promise.withResolvers<void>()
    const first = queue.run('a', signal(), () => firstGate.promise)
    let started = false
    const second = queue.run('b', signal(), async () => { started = true; await secondGate.promise })
    await vi.advanceTimersByTimeAsync(900)
    firstGate.resolve()
    await first
    await vi.advanceTimersByTimeAsync(2000)
    expect(started).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    secondGate.resolve()
    await second
  })

  it('每会话待处理数量受限，不把正在执行的动作算作等待', async () => {
    const queue = new MemeActionQueue(1, { maxPendingPerConversation: 2 })
    const gate = Promise.withResolvers<void>()
    const work = vi.fn(async () => {})
    const first = queue.run('a', signal(), () => gate.promise)
    const second = queue.run('a', signal(), work)
    const third = queue.run('a', signal(), work)
    try {
      await expect(queue.run('a', signal(), work)).rejects.toThrow('当前会话待处理')
      expect(work).not.toHaveBeenCalled()
    } finally { gate.resolve(); await Promise.all([first, second, third]) }
    expect(work).toHaveBeenCalledTimes(2)
    await queue.run('a', signal(), work)
    expect(work).toHaveBeenCalledTimes(3)
  })

  it('插件总等待数量受限，多个会话不能绕过总量上限', async () => {
    const queue = new MemeActionQueue(1, { maxPendingTotal: 2 })
    const gate = Promise.withResolvers<void>()
    const work = vi.fn(async () => {})
    const first = queue.run('a', signal(), () => gate.promise)
    const second = queue.run('b', signal(), work)
    const third = queue.run('c', signal(), work)
    try { await expect(queue.run('d', signal(), work)).rejects.toThrow('等待队列已满') }
    finally { gate.resolve(); await Promise.all([first, second, third]) }
    expect(work).toHaveBeenCalledTimes(2)
  })

  it('其他会话占满等待名额时，有空闲槽的新会话仍能开始', async () => {
    const queue = new MemeActionQueue(2, { maxPendingTotal: 1 })
    const gate = Promise.withResolvers<void>()
    const first = queue.run('a', signal(), () => gate.promise)
    const waiting = vi.fn(async () => {})
    const next = queue.run('a', signal(), waiting)
    const free = vi.fn(async () => {})
    try {
      await queue.run('b', signal(), free)
      expect(free).toHaveBeenCalledTimes(1)
      expect(waiting).not.toHaveBeenCalled()
    } finally { gate.resolve(); await Promise.all([first, next]) }
  })

  it('即使到期计时器尚未执行，也不启动超过排队期限的动作', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const queue = new MemeActionQueue(1, { maxWaitMs: 1000 })
    const work = vi.fn(async () => {})
    const task = queue.run('a', signal(), work)
    const rejected = expect(task).rejects.toThrow('排队超时')
    vi.setSystemTime(Date.now() + 2000)
    await rejected
    expect(work).not.toHaveBeenCalled()
    await queue.run('a', signal(), work)
    expect(work).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('已取消动作不入队，并在完成后移除排队信号监听', async () => {
    const queue = new MemeActionQueue(1)
    const controller = new AbortController()
    const work = vi.fn(async () => {})
    controller.abort(new Error('已经取消'))
    await expect(queue.run('a', controller.signal, work)).rejects.toThrow('已经取消')
    expect(work).not.toHaveBeenCalled()
    const pending = new AbortController()
    const remove = vi.spyOn(pending.signal, 'removeEventListener')
    await queue.run('a', pending.signal, work)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})
