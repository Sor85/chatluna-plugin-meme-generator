import type { Context } from 'cordis'
import { Schema } from '@chatluna/schema'
import { fileRefTableOf, type ChatFileBlock, type ChatMessage, type JsonValue } from '@chatluna/message'
import { h, type Session } from '@satorijs/core'
import type { ToolCallContext, ToolDefinition, ToolResultView } from '@chatluna/tool'
import type {} from '@chatluna/chat'
import type {} from '@chatluna/storage-files'
import type { Config } from './config'
import type { registerCommands } from './command/register'
import type { GenerateImageInput } from './types'
import { applyAutoFillPolicy } from './domain/policy'
import { downloadImage, MAX_IMAGE_BYTES } from './utils/image'
import { getBotAvatarImage, getSenderAvatarImage, resolveAvatarImageByUserId, resolveDisplayNameByUserId, resolveSenderDisplayName } from './utils/avatar'

function values(description?: string) {
  return Schema.union([Schema.string(), Schema.array(Schema.string())]).optional().description(description ?? '')
}
const actionSchema = Schema.object({
  key: Schema.string().min(1).required().description('Template key or alias'),
  text: values('Texts, as an array or separated by |'),
  image: values('Image refs from this conversation, or public HTTP(S) URLs'),
  at: values('User IDs for avatars, in order; separated by |'),
  texts: values(),
  images: values(),
  ats: values()
})

interface MemeAction {
  key: string
  text?: string | string[]
  image?: string | string[]
  at?: string | string[]
  texts?: string | string[]
  images?: string | string[]
  ats?: string | string[]
}
interface MemeArgs extends Omit<MemeAction, 'key'> {
  key?: string
  actions?: MemeAction[]
}
interface MessageSource { messages(): readonly ChatMessage[] }
function isMessageSource(value: unknown): value is MessageSource {
  return value !== null && typeof value === 'object' && 'messages' in value && typeof value.messages === 'function'
}
function messagesOf(call: ToolCallContext): readonly ChatMessage[] {
  const agent = call.agent
  const source = agent && 'session' in agent ? agent.session : undefined
  return isMessageSource(source) ? source.messages() : []
}
export function normalizeValues(value: string | string[] | undefined): string[] {
  return [...new Set((typeof value === 'string' ? value.split('|') : value ?? []).map((item) => item.trim()).filter(Boolean))]
}

async function inputImage(ctx: Context, source: string, call: ToolCallContext, config: Config): Promise<GenerateImageInput> {
  if (/^https?:\/\//i.test(source)) return downloadImage(ctx, source, config.timeoutMs, 'tool-image', call.signal)
  const block = fileRefTableOf(messagesOf(call)).resolve(source)
  if (!block || !block.mediaType.startsWith('image/')) throw new Error(`当前会话中没有图片 ${source}`)
  const { data } = block
  if (data.type === 'url') return downloadImage(ctx, data.url, config.timeoutMs, 'tool-image', call.signal)
  if (data.type === 'text') throw new Error('图片引用不包含二进制数据')
  let buffer: Buffer
  if (data.type === 'data') {
    if (data.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error('图片大小超过 10 MiB')
    buffer = Buffer.from(data.data, 'base64')
  } else {
    if (!data.reference.startsWith('storage://')) throw new Error('不支持的图片存储引用')
    const storage = ctx.get('chatluna_storage')
    if (!storage) throw new Error('图片存储服务不可用')
    const file = await storage.getTempFile(data.reference.slice('storage://'.length))
    if (!file) throw new Error('图片引用已过期')
    if (file.size > MAX_IMAGE_BYTES) throw new Error('图片大小超过 10 MiB')
    buffer = await file.data
  }
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new Error('图片为空或超过 10 MiB')
  return { data: buffer, mimeType: block.mediaType, filename: block.filename ?? 'image.png' }
}

export function renderMemeResult(_args: MemeArgs, value: JsonValue): ToolResultView {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value['images'])) return { kind: 'generic', title: 'meme' }
  const images: ChatFileBlock[] = []
  for (const item of value['images']) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const mimeType = item['mimeType']
    const base64 = item['base64']
    if (typeof mimeType !== 'string' || typeof base64 !== 'string') continue
    images.push({ type: 'file', mediaType: mimeType, data: { type: 'data', data: base64 } })
  }
  return { kind: 'generic', title: 'meme', content: [{ type: 'text', text: '表情图片已发送到当前会话，不需重复发送。' }, ...images] }
}

export function registerTools(ctx: Context, config: Config, runtime: ReturnType<typeof registerCommands>) {
  const actionsSchema = Schema.array(actionSchema).min(1).max(20).optional()
  // Schemastery arrays implicitly default to []; omission must keep the single-key form active.
  delete actionsSchema.meta.default
  const tool: ToolDefinition<MemeArgs> = {
    name: 'meme_generate',
    description: 'Generate and SEND meme images to the current chat. Use a template key or alias, optional texts, conversation image refs/public image URLs, and user IDs for avatars. Missing inputs follow configured automatic completion. For several memes, use actions in order. The images are already sent; do not send them again.',
    locales: { zh: { description: '生成并发送表情图片，支持模板别名、文字、会话图片引用、头像和批量动作' } },
    args: Schema.object({
      key: Schema.string().optional(), text: values(), image: values(), at: values(),
      texts: values(), images: values(), ats: values(),
      actions: actionsSchema
    }),
    traits: { effect: 'write', parallel: false, timeout: config.timeoutMs * 10, background: false },
    async run(args, call) {
      const session = call.routeId ? ctx.chat.inbound(call.routeId) : undefined
      if (!session) throw new Error('meme_generate 需要绑定平台会话')
      const actions = args.actions ?? (args.key?.trim() ? [{ ...args, key: args.key }] : [])
      if (!actions.length) throw new Error('必须提供模板 key 或 actions')
      const images: { key: string; mimeType: string; base64: string }[] = []
      for (const action of actions) {
        call.signal.throwIfAborted()
        await runtime.ensureCategoryExcludedMemeKeySet()
        const key = await runtime.resolveMemeKey(action.key)
        if (runtime.isExcludedMemeKey(key, session)) throw new Error('该模板已被排除。')
        const texts = normalizeValues(action.text ?? action.texts)
        const inputs: GenerateImageInput[] = []
        for (const image of normalizeValues(action.image ?? action.images)) inputs.push(await inputImage(ctx, image, call, config))
        const mentions = [...new Set(normalizeValues(action.at ?? action.ats).map((id) => id.replace(/^@+/, '')).filter(Boolean))]
        const mentionedAvatars: GenerateImageInput[] = []
        for (const id of mentions) {
          call.signal.throwIfAborted()
          const avatar = await resolveAvatarImageByUserId(ctx, session, id, config.timeoutMs)
          if (avatar) mentionedAvatars.push(avatar)
        }
        const senderName = await resolveSenderDisplayName(session)
        const groupNicknameText = config.autoUseGroupNicknameWhenNoDefaultText
          ? (mentions[0] ? await resolveDisplayNameByUserId(session, mentions[0]) : undefined) || senderName : undefined
        const info = await runtime.client.getInfo(key, call.signal)
        const input = applyAutoFillPolicy({
          texts, images: inputs, params: info.params_type, config,
          senderAvatarImage: await getSenderAvatarImage(ctx, session, config.timeoutMs),
          mentionedAvatarImages: mentionedAvatars,
          botAvatarImage: await getBotAvatarImage(ctx, session, config.timeoutMs), senderName, groupNicknameText
        })
        const result = await runtime.client.generate(key, input.images, input.texts, {}, call.signal)
        call.signal.throwIfAborted()
        await sendImage(session, result.buffer, result.mimeType)
        images.push({ key, mimeType: result.mimeType, base64: Buffer.from(result.buffer).toString('base64') })
      }
      return { sent: true, images }
    },
    render: { result: renderMemeResult }
  }
  ctx.tools.define(tool)
  ctx.chat.action('meme', {
    description: 'Generate and send a meme. Texts, image refs/URLs and avatar user IDs are separated by |.',
    locales: { zh: { description: '生成并发送表情图片，多个参数使用 | 分隔' } },
    attrs: actionSchema,
    example: '<meme key="hug" at="user-id|bot-id"/>',
    default: true,
    tool: 'meme_generate'
  })
  ctx.logger.info('Registered meme_generate tool and meme action')
}

async function sendImage(session: Session, buffer: Uint8Array, mimeType: string) {
  await session.send(h.image(Buffer.from(buffer), mimeType))
}
