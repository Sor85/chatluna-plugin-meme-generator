/**
 * 插件配置模型与默认值
 * 按功能分组定义控制台配置项
 */

import { Schema } from "@chatluna/schema";

export type EmptyTextAutoFillSource = "template-default" | "user-nickname";

export interface EmptyTextAutoFillRule {
  source: EmptyTextAutoFillSource;
  enabled: boolean;
  weight: number;
}

export type RandomMemeBucketCategory =
  | "text-only"
  | "single-image-only"
  | "two-image-only"
  | "image-and-text"
  | "other";

export interface RandomMemeBucketWeightRule {
  category: RandomMemeBucketCategory;
  enabled: boolean;
  weight: number;
}

export interface GroupExcludedMemeKeyRule {
  groupId: string;
  excludedMemeKeys: string[];
}

export type MemeListImageMode = "single" | "multiple";

export interface Config {
  baseUrl: string;
  timeoutMs: number;
  emptyTextAutoFillRules: EmptyTextAutoFillRule[];
  autoUseAvatarWhenMinImagesOneAndNoImage: boolean;
  autoFillOneMissingImageWithAvatar: boolean;
  autoFillSenderAndBotAvatarsWhenMinImagesTwoAndNoImage: boolean;
  autoUseGroupNicknameWhenNoDefaultText: boolean;
  enableQuotedImageTrigger: boolean;
  enableQuotedTextTrigger: boolean;
  renderMemeListAsImage: boolean;
  memeListImageMode: MemeListImageMode;
  sendMemeListAsForward: boolean;
  sendMemeSearchAsForward: boolean;
  enableMemeCommandTrigger: boolean;
  enableDirectAliasWithoutPrefix: boolean;
  allowKeyWithoutPrefixTrigger: boolean;
  allowMentionPrefixDirectAliasTrigger: boolean;
  allowLeadingAtBeforeCommand: boolean;
  enableDeveloperDebugLog: boolean;
  randomOutputMemeKey: string;
  enableMemeXmlTool: boolean;
  memeActionConcurrency: number;
  memeActionQueueTimeoutSeconds: number;
  memeActionQueueLimit: number;
  memeSearchCacheMinutes: number;
  enableRandomDedupeWithinHours: boolean;
  randomDedupeWindowHours: number;
  enableRandomKeywordNotice: boolean;
  randomMemeBucketWeightRules: RandomMemeBucketWeightRule[];
  infoFetchConcurrency: number;
  initLoadRetryTimes: number;
  disableErrorReplyToPlatform: boolean;
  excludeTextOnlyMemes: boolean;
  excludeSingleImageOnlyMemes: boolean;
  excludeTwoImageOnlyMemes: boolean;
  excludeImageAndTextMemes: boolean;
  excludeOtherMemes: boolean;
  excludedMemeKeys: string[];
  groupExcludedMemeKeys: GroupExcludedMemeKeyRule[];
  showMemeListKey: boolean;
}

export const defaultConfig: Config = {
  baseUrl: "",
  timeoutMs: 5000,
  emptyTextAutoFillRules: [
    {
      source: "template-default",
      enabled: true,
      weight: 100,
    },
    {
      source: "user-nickname",
      enabled: true,
      weight: 100,
    },
  ],
  autoUseAvatarWhenMinImagesOneAndNoImage: true,
  autoFillOneMissingImageWithAvatar: true,
  autoFillSenderAndBotAvatarsWhenMinImagesTwoAndNoImage: true,
  autoUseGroupNicknameWhenNoDefaultText: true,
  enableQuotedImageTrigger: true,
  enableQuotedTextTrigger: false,
  renderMemeListAsImage: true,
  memeListImageMode: "single",
  sendMemeListAsForward: true,
  sendMemeSearchAsForward: true,
  enableMemeCommandTrigger: true,
  enableDirectAliasWithoutPrefix: true,
  allowKeyWithoutPrefixTrigger: true,
  allowMentionPrefixDirectAliasTrigger: false,
  allowLeadingAtBeforeCommand: false,
  enableDeveloperDebugLog: false,
  randomOutputMemeKey: "",
  enableMemeXmlTool: false,
  memeActionConcurrency: 4,
  memeActionQueueTimeoutSeconds: 30,
  memeActionQueueLimit: 5,
  memeSearchCacheMinutes: 30,
  enableRandomDedupeWithinHours: true,
  randomDedupeWindowHours: 24,
  enableRandomKeywordNotice: true,
  randomMemeBucketWeightRules: [
    { category: "text-only", enabled: true, weight: 100 },
    { category: "single-image-only", enabled: true, weight: 100 },
    { category: "two-image-only", enabled: true, weight: 100 },
    { category: "image-and-text", enabled: true, weight: 100 },
    { category: "other", enabled: true, weight: 100 },
  ],
  infoFetchConcurrency: 0,
  initLoadRetryTimes: 3,
  disableErrorReplyToPlatform: true,
  excludeTextOnlyMemes: false,
  excludeSingleImageOnlyMemes: false,
  excludeTwoImageOnlyMemes: false,
  excludeImageAndTextMemes: false,
  excludeOtherMemes: false,
  excludedMemeKeys: [],
  groupExcludedMemeKeys: [],
  showMemeListKey: false,
};

const basicSchema = Schema.object({
  baseUrl: Schema.string()
    .role("link")
    .default(defaultConfig.baseUrl)
    .description("后端服务地址"),
  timeoutMs: Schema.number()
    .min(1000)
    .max(60000)
    .default(defaultConfig.timeoutMs)
    .description("请求超时时间（毫秒）"),
}).description("基础设置");

const textSchema = Schema.object({
  emptyTextAutoFillRules: Schema.array(
    Schema.object({
      source: Schema.union([
        Schema.const("template-default").description("模板默认文字"),
        Schema.const("user-nickname").description("用户昵称"),
      ]).required(),
      enabled: Schema.boolean().default(true).description("是否启用"),
      weight: Schema.number()
        .min(0)
        .max(1000)
        .step(1)
        .default(100)
        .description("权重（双开来源时用于随机分配）"),
    }),
  )
    .role("meme-generator:weights")
    .default(defaultConfig.emptyTextAutoFillRules)
    .description("未提供文本时的自动补全文案来源"),
  autoUseGroupNicknameWhenNoDefaultText: Schema.boolean()
    .default(defaultConfig.autoUseGroupNicknameWhenNoDefaultText)
    .description("模板无默认文字时是否优先使用群昵称补文案"),
}).description("文本补全设置");

const imageSchema = Schema.object({
  autoUseAvatarWhenMinImagesOneAndNoImage: Schema.boolean()
    .default(defaultConfig.autoUseAvatarWhenMinImagesOneAndNoImage)
    .description("最少需 1 图且无图时自动补发送者头像"),
  autoFillOneMissingImageWithAvatar: Schema.boolean()
    .default(defaultConfig.autoFillOneMissingImageWithAvatar)
    .description("已提供图片且仅差 1 图时自动补发送者头像"),
  autoFillSenderAndBotAvatarsWhenMinImagesTwoAndNoImage: Schema.boolean()
    .default(
      defaultConfig.autoFillSenderAndBotAvatarsWhenMinImagesTwoAndNoImage,
    )
    .description("最少需 2 图且无图时自动补发送者与`bot`头像"),
}).description("图片补全设置");

const randomSchema = Schema.object({
  enableRandomDedupeWithinHours: Schema.boolean()
    .default(defaultConfig.enableRandomDedupeWithinHours)
    .description("是否开启`meme.random`时间窗口去重"),
  randomDedupeWindowHours: Schema.number()
    .min(1)
    .max(720)
    .step(1)
    .default(defaultConfig.randomDedupeWindowHours)
    .description("`meme.random`去重时间窗口（小时）"),
  enableRandomKeywordNotice: Schema.boolean()
    .default(defaultConfig.enableRandomKeywordNotice)
    .description("`meme.random`是否附带模板关键词提示"),
  randomMemeBucketWeightRules: Schema.array(
    Schema.object({
      category: Schema.union([
        Schema.const("text-only").description("仅需文字"),
        Schema.const("single-image-only").description("仅需 1 张图片"),
        Schema.const("two-image-only").description("需 2 张图片"),
        Schema.const("image-and-text").description("需图片+文字"),
        Schema.const("other").description("其他模板"),
      ]).required(),
      enabled: Schema.boolean().default(true).description("是否启用"),
      weight: Schema.number()
        .min(0)
        .max(1000)
        .step(1)
        .default(100)
        .description("权重"),
    }),
  )
    .role("meme-generator:weights")
    .default(defaultConfig.randomMemeBucketWeightRules)
    .description("`meme.random`随机时的权重配置"),
}).description("随机触发设置");

const triggerSchema = Schema.object({
  enableMemeCommandTrigger: Schema.boolean()
    .default(defaultConfig.enableMemeCommandTrigger)
    .description("是否允许通过`meme key`或`meme 中文别名`生成 meme"),
  enableDirectAliasWithoutPrefix: Schema.boolean()
    .default(defaultConfig.enableDirectAliasWithoutPrefix)
    .description("是否允许中文别名跳过 meme 前缀直接触发"),
  allowKeyWithoutPrefixTrigger: Schema.boolean()
    .default(defaultConfig.allowKeyWithoutPrefixTrigger)
    .description("是否允许`key`跳过 meme 前缀直接触发"),
  allowMentionPrefixDirectAliasTrigger: Schema.boolean()
    .default(defaultConfig.allowMentionPrefixDirectAliasTrigger)
    .description("是否允许贴合参数触发，支持`meme key/中文别名@用户文本`，无前缀触发范围取决于已开启的中文别名或 key 直触发设置"),
  allowLeadingAtBeforeCommand: Schema.boolean()
    .default(defaultConfig.allowLeadingAtBeforeCommand)
    .description("是否允许前置 @ 参数触发，如`@用户 meme key/中文别名`"),
  enableQuotedImageTrigger: Schema.boolean()
    .default(defaultConfig.enableQuotedImageTrigger)
    .description("是否允许引用消息中的图片参与触发"),
  enableQuotedTextTrigger: Schema.boolean()
    .default(defaultConfig.enableQuotedTextTrigger)
    .description("是否在未提供文本参数时使用引用消息文字触发"),
  enableMemeXmlTool: Schema.boolean()
    .default(defaultConfig.enableMemeXmlTool)
    .description("启用只读`meme_search`模板查询工具与生成发送图片的`meme`动作"),
  memeActionConcurrency: Schema.natural()
    .min(1).max(16).step(1)
    .default(defaultConfig.memeActionConcurrency)
    .description("不同平台会话同时执行表情动作的上限。同一会话内按顺序执行，排队不计入生成超时；不改变普通聊天与人工命令的并发策略"),
  memeActionQueueTimeoutSeconds: Schema.natural()
    .min(1).max(300).step(1)
    .default(defaultConfig.memeActionQueueTimeoutSeconds)
    .description("表情动作最长排队时间（秒），与生成超时独立计时。排队超时会取消该动作并返回失败，不在之后补发图片"),
  memeActionQueueLimit: Schema.natural()
    .min(1).max(20).step(1)
    .default(defaultConfig.memeActionQueueLimit)
    .description("每个平台会话最多等待执行的表情动作数，不含正在执行的动作。插件实例的等待总量最多 100 条，超限立即返回失败"),
  memeSearchCacheMinutes: Schema.number()
    .min(1).max(1440).step(1)
    .default(defaultConfig.memeSearchCacheMinutes)
    .description("模板检索元数据的内存缓存时长（分钟），过期或重启后重新读取后端模板资料"),
}).description("触发方式设置");

const filterSchema = Schema.object({
  excludeTextOnlyMemes: Schema.boolean()
    .default(defaultConfig.excludeTextOnlyMemes)
    .description("是否排除仅需文字的模板"),
  excludeSingleImageOnlyMemes: Schema.boolean()
    .default(defaultConfig.excludeSingleImageOnlyMemes)
    .description("是否排除仅需 1 张图片的模板"),
  excludeTwoImageOnlyMemes: Schema.boolean()
    .default(defaultConfig.excludeTwoImageOnlyMemes)
    .description("是否排除需 2 张图片的模板"),
  excludeImageAndTextMemes: Schema.boolean()
    .default(defaultConfig.excludeImageAndTextMemes)
    .description("是否排除需图片+文字的模板"),
  excludeOtherMemes: Schema.boolean()
    .default(defaultConfig.excludeOtherMemes)
    .description("是否排除未命中现有类别排除项的其他模板"),
  excludedMemeKeys: Schema.array(Schema.string().min(1))
    .role("table")
    .default(defaultConfig.excludedMemeKeys)
    .description("全局排除模板`key`列表"),
  groupExcludedMemeKeys: Schema.array(
    Schema.object({
      groupId: Schema.string().required().description("群号"),
      excludedMemeKeys: Schema.array(Schema.string().min(1))
        .role("table")
        .default([])
        .description("该群额外排除模板`key`列表"),
    }),
  )
    .role("table")
    .default(defaultConfig.groupExcludedMemeKeys)
    .description("分群排除模板`key`列表"),
}).description("模板筛选设置");

const runtimeSchema = Schema.object({
  infoFetchConcurrency: Schema.number()
    .min(0)
    .max(100)
    .step(1)
    .default(defaultConfig.infoFetchConcurrency)
    .description("模板信息拉取并发上限（0 为不限制）"),
  initLoadRetryTimes: Schema.number()
    .min(0)
    .max(20)
    .step(1)
    .default(defaultConfig.initLoadRetryTimes)
    .description("初始化载入模板失败后的自动重试次数"),
  disableErrorReplyToPlatform: Schema.boolean()
    .default(defaultConfig.disableErrorReplyToPlatform)
    .description("是否关闭平台错误回复（仅写日志）"),
  renderMemeListAsImage: Schema.boolean()
    .default(defaultConfig.renderMemeListAsImage)
    .description("`meme.list`是否以图片形式输出"),
  memeListImageMode: Schema.union([
    Schema.const("single").description("合成单张长图"),
    Schema.const("multiple").description("按页拆成多张图片"),
  ])
    .default(defaultConfig.memeListImageMode)
    .description("`meme.list`图片模式"),
  sendMemeListAsForward: Schema.boolean()
    .default(defaultConfig.sendMemeListAsForward)
    .description("`meme.list`是否以 OneBot 合并转发发送"),
  sendMemeSearchAsForward: Schema.boolean()
    .default(defaultConfig.sendMemeSearchAsForward)
    .description("`meme.search`是否以 OneBot 合并转发发送"),
  showMemeListKey: Schema.boolean()
    .default(defaultConfig.showMemeListKey)
    .description("`meme.list`是否显示模板 key"),
}).description("其他设置");

const developerSchema = Schema.object({
  enableDeveloperDebugLog: Schema.boolean()
    .default(defaultConfig.enableDeveloperDebugLog)
    .description("开启调试日志"),
  randomOutputMemeKey: Schema.string()
    .default(defaultConfig.randomOutputMemeKey)
    .description("指定`meme.random`输出的模板`key`，留空不启用"),
}).description("开发者模式");

const groups = [basicSchema, textSchema, imageSchema, randomSchema, triggerSchema, filterSchema, runtimeSchema, developerSchema];
const labels: Record<string, string> = {
  baseUrl: "后端地址", timeoutMs: "请求超时", emptyTextAutoFillRules: "文案来源与权重",
  autoUseAvatarWhenMinImagesOneAndNoImage: "单图模板补头像", autoFillOneMissingImageWithAvatar: "补齐一张图片",
  autoFillSenderAndBotAvatarsWhenMinImagesTwoAndNoImage: "双头像补全", autoUseGroupNicknameWhenNoDefaultText: "群昵称回退",
  enableQuotedImageTrigger: "使用引用图片", enableQuotedTextTrigger: "使用引用文字",
  renderMemeListAsImage: "图片列表", memeListImageMode: "列表图片模式", sendMemeListAsForward: "列表合并转发",
  sendMemeSearchAsForward: "搜索合并转发", showMemeListKey: "显示模板键",
  enableMemeCommandTrigger: "生成命令", enableDirectAliasWithoutPrefix: "无前缀别名",
  allowKeyWithoutPrefixTrigger: "无前缀模板键", allowMentionPrefixDirectAliasTrigger: "贴合参数", allowLeadingAtBeforeCommand: "前置提及",
  enableDeveloperDebugLog: "调试日志", randomOutputMemeKey: "固定随机模板",
  enableMemeXmlTool: "原生动作与工具",
  memeActionConcurrency: "表情动作并发", memeActionQueueTimeoutSeconds: "动作排队超时", memeActionQueueLimit: "每会话等待上限", memeSearchCacheMinutes: "模板索引缓存",
  enableRandomDedupeWithinHours: "随机去重", randomDedupeWindowHours: "去重窗口", enableRandomKeywordNotice: "随机模板提示",
  randomMemeBucketWeightRules: "随机类别权重", infoFetchConcurrency: "信息拉取并发", initLoadRetryTimes: "初始化重试",
  disableErrorReplyToPlatform: "静默平台错误", excludeTextOnlyMemes: "排除纯文字模板", excludeSingleImageOnlyMemes: "排除单图模板",
  excludeTwoImageOnlyMemes: "排除双图及多图模板", excludeImageAndTextMemes: "排除图文模板", excludeOtherMemes: "排除其他模板",
  excludedMemeKeys: "排除模板", groupExcludedMemeKeys: "分群排除模板", groupId: "群号",
  source: "来源", category: "类别", enabled: "启用", weight: "权重"
};

function labelFields(schema: Schema) {
  const fields = schema.dict;
  for (const [key, field] of Object.entries(fields ?? {})) {
    const labeled = labels[key] ? field.extra("label", labels[key]) : field;
    const described = typeof field.meta.description === "string"
      ? labeled.description(field.meta.description.replaceAll("是否", ""))
      : labeled;
    if (fields) fields[key] = described;
    labelFields(described);
  }
  if (schema.inner) labelFields(schema.inner);
  for (const item of schema.list ?? []) labelFields(item);
}
for (const group of groups) labelFields(group);

export const Config: Schema<Config> = Schema.intersect(groups);
