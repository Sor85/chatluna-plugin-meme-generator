import type { Context } from 'cordis'
import { Schema } from '@chatluna/schema'
import { fileRefTableOf, type ChatMessage } from '@chatluna/message'
import { h } from '@satorijs/core'
import type {} from '@chatluna/chat'
import type {} from '@chatluna/agent'
import type {} from '@chatluna/storage-files'
import type { Config } from './config'
import type { registerCommands } from './command/register'
import type { GenerateImageInput } from './types'
import { applyAutoFillPolicy } from './domain/policy'
import { isParamsTypeExcludedByConfig } from './command/register/meme-list'
import { downloadImage, MAX_IMAGE_BYTES } from './utils/image'
import { getBotAvatarImage, getSenderAvatarImage, resolveAvatarImageByUserId, resolveDisplayNameByUserId, resolveSenderDisplayName } from './utils/avatar'
import { abortable } from './utils/abort'
import { MemeActionQueue, memeConversationKey } from './action-queue'

function values(description = '') {
  return Schema.union([Schema.string(), Schema.array(Schema.string())]).optional().description(description)
}
const actionSchema = Schema.object({
  key: Schema.string().min(1).required().description('Exact template key returned by meme_search, or a known alias'),
  text: values('Texts, as an array or separated by |'),
  image: values('Image refs from this conversation, or public HTTP(S) URLs'),
  at: values('User IDs for avatars, in order; separated by |'),
  texts: values(), images: values(), ats: values()
})
export function normalizeValues(value: string | string[] | undefined): string[] {
  return [...new Set((typeof value === 'string' ? value.split('|') : value ?? []).map((item) => item.trim()).filter(Boolean))]
}

async function inputImage(ctx: Context, source: string, messages: readonly ChatMessage[], config: Config, signal: AbortSignal): Promise<GenerateImageInput> {
  if (/^https?:\/\//i.test(source)) return downloadImage(ctx, source, config.timeoutMs, 'action-image', signal)
  const block = fileRefTableOf(messages).resolve(source)
  if (!block || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(block.mediaType)) throw new Error(`当前会话中没有支持的图片 ${source}`)
  const { data } = block
  if (data.type === 'url') return downloadImage(ctx, data.url, config.timeoutMs, 'action-image', signal)
  if (data.type === 'text') throw new Error('图片引用不包含二进制数据')
  let buffer: Buffer
  if (data.type === 'data') {
    if (data.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error('图片大小超过 10 MiB')
    buffer = Buffer.from(data.data, 'base64')
  } else {
    if (!data.reference.startsWith('storage://')) throw new Error('不支持的图片存储引用')
    const storage = ctx.get('chatluna_storage')
    if (!storage) throw new Error('图片存储服务不可用')
    const file = await abortable(storage.getTempFile(data.reference.slice('storage://'.length)), signal)
    if (!file) throw new Error('图片引用已过期')
    if (file.size > MAX_IMAGE_BYTES) throw new Error('图片大小超过 10 MiB')
    buffer = await abortable(file.data, signal)
  }
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new Error('图片为空或超过 10 MiB')
  return { data: buffer, mimeType: block.mediaType, filename: block.filename ?? 'image.png' }
}

export function registerMemeAction(ctx: Context, config: Config, runtime: ReturnType<typeof registerCommands>) {
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  const queue = new MemeActionQueue(config.memeActionConcurrency, {
    maxWaitMs: config.memeActionQueueTimeoutSeconds * 1000,
    maxPendingPerConversation: config.memeActionQueueLimit
  })
  ctx.chat.action('meme', {
    description: 'Generate and SEND a meme image. If the template key or requirements are unknown, first call meme_search with a few short keywords; select an available returned key, then use this action. text, image refs/public URLs and avatar user IDs accept | separated values. Missing inputs follow configured completion. Use multiple <meme> actions for multiple images; they execute in order within the same conversation. This action sends the image itself; do not send it again. Do not automatically retry expired or over-limit actions. Never invent template keys.',
    locales: { zh: { description: '根据模板生成并发送表情；模板或参数未知时先通过 meme_search 查询，多个参数使用 | 分隔' } },
    attrs: actionSchema,
    example: '<meme key="hug" at="user-id|bot-id"/>',
    default: true,
    async run(attrs, action) {
      // The host invokes custom run handlers with raw XML attrs; their Schema is not validated automatically.
      const parsed = actionSchema.safeParse(attrs)
      if (!parsed.success || !parsed.data.key.trim()) throw new Error('meme 动作参数无效，必须提供模板 key')
      const session = action.session
      if (!session) throw new Error('meme 动作需要绑定平台会话')
      const agent = action.sessionId ? ctx.get('agents')?.get(action.sessionId) : undefined
      const cancellation = AbortSignal.any([lifetime.signal, ...(agent ? [agent.signal] : [])])
      const messages = agent?.session.messages() ?? []
      const task = queue.run(memeConversationKey(session), cancellation, async () => {
        // Waiting does not consume the execution deadline; cancellation still applies while queued.
        const signal = AbortSignal.any([cancellation, AbortSignal.timeout(config.timeoutMs * 10)])
        signal.throwIfAborted()
        const args = parsed.data
        const key = await abortable(runtime.resolveMemeKey(args.key), signal)
        if (runtime.isExcludedMemeKey(key, session)) throw new Error('该模板已被排除。')
        const info = await runtime.client.getInfo(key, signal)
        if (isParamsTypeExcludedByConfig(info.params_type, config)) throw new Error('该模板类别已被排除。')
        const texts = normalizeValues(args.text ?? args.texts)
        const inputs: GenerateImageInput[] = []
        for (const image of normalizeValues(args.image ?? args.images)) inputs.push(await inputImage(ctx, image, messages, config, signal))
        const mentions = [...new Set(normalizeValues(args.at ?? args.ats).map((id) => id.replace(/^@+/, '')).filter(Boolean))]
        const mentionedAvatars: GenerateImageInput[] = []
        for (const id of mentions) {
          signal.throwIfAborted()
          const avatar = await abortable(resolveAvatarImageByUserId(ctx, session, id, config.timeoutMs), signal)
          if (avatar) mentionedAvatars.push(avatar)
        }
        const senderName = await abortable(resolveSenderDisplayName(session), signal)
        const groupNicknameText = config.autoUseGroupNicknameWhenNoDefaultText
          ? (mentions[0] ? await abortable(resolveDisplayNameByUserId(session, mentions[0]), signal) : undefined) || senderName : undefined
        const input = applyAutoFillPolicy({
          texts, images: inputs, params: info.params_type, config,
          senderAvatarImage: await abortable(getSenderAvatarImage(ctx, session, config.timeoutMs), signal),
          mentionedAvatarImages: mentionedAvatars,
          botAvatarImage: await abortable(getBotAvatarImage(ctx, session, config.timeoutMs), signal), senderName, groupNicknameText
        })
        const result = await runtime.client.generate(key, input.images, input.texts, {}, signal)
        signal.throwIfAborted()
        await session.send(h.image(Buffer.from(result.buffer), result.mimeType))
      })
      await abortable(task, cancellation)
    }
  })
  ctx.logger.info('Registered independent meme action')
}
