/**
 * 命令注册与执行链路
 * 注册 meme 相关命令并完成生成请求调用
 */

import type { Context } from "cordis";
import { h, type Session } from "@satorijs/core";
import type {} from "koishi";
import type {} from "chatluna-plugin-takumi";
import type { Config } from "../config";
import { excludedKeys, type MemeSettings } from "../settings";
import { downloadImage } from "../utils/image";
import { MemeBackendClient } from "../backend";
import {
  createMemeKeyResolver,
  createMemeTriggerPrefixResolver,
  shouldRegisterDirectAlias,
} from "./key-resolver";
import {
  categoryExcludedKeys,
  fetchCategoryParams,
  hasCategoryExclusion,
  buildMemeListEntries,
  buildMemeListSections,
  buildListImages,
  formatMemeListImageMessage,
  fetchMemeListInfos,
  formatMemeSearchResultMessage,
  formatMemeListLines,
  searchMemeInfos,
  sendMemeListForwardMessage,
  sendMemeListImageForwardMessage,
  sendMemeSearchForwardMessage,
  splitMemeListMessages,
} from "./register/meme-list";
import {
  filterExcludedMemeKeys,
  isExcludedMemeKey,
} from "./register/exclusion";
import { mapRuntimeErrorMessage, replyOrSilent } from "./register/errors";
import { handleGenerate } from "./register/generate";
import {
  installDirectAliasRuntime,
  normalizeMergedTriggerRestText,
} from "./register/direct-alias-runtime";
import { installRandomRuntime } from "./register/random-runtime";
import type { MemeInfoResponse, MemeParamsType } from "../types";

interface LeadingAtCommandParts {
  leadingAtSegments: string[];
  commandText: string;
  suffix: string;
}

interface ElementLike {
  type?: string;
  attrs?: {
    id?: string;
    content?: unknown;
  };
}

function resolveSessionTextContent(session: {
  content?: unknown;
  stripped?: { content?: unknown };
}): string {
  const rawContent =
    typeof session.content === "string" ? session.content.trim() : "";
  if (rawContent) return rawContent;

  const strippedContent =
    typeof session.stripped?.content === "string"
      ? session.stripped.content.trim()
      : "";
  return strippedContent;
}

function extractAtIdSegments(rawAts: string): string[] {
  const segments: string[] = [];
  const idPattern = /\bid\s*=\s*"([^"]+)"/gi;
  let match: RegExpExecArray | null = idPattern.exec(rawAts);
  while (match) {
    const id = (match[1] || "").trim();
    if (id) segments.push(`<at id="${id}"/>`);
    match = idPattern.exec(rawAts);
  }
  return segments;
}

function parseLeadingAtBeforeMemeCommand(
  content: string,
): LeadingAtCommandParts | undefined {
  const normalized = content.trim();
  if (!normalized) return undefined;

  const segmentMatch = normalized.match(
    /^((?:<at\b[^>]*>(?:<\/at>)?\s*)+)(\S+)([\s\S]*)$/i,
  );
  if (segmentMatch) {
    const leadingAtSegments = extractAtIdSegments(segmentMatch[1] || "");
    const commandText = (segmentMatch[2] || "").trim();
    if (leadingAtSegments.length === 0 || !commandText) return undefined;
    return {
      leadingAtSegments,
      commandText,
      suffix: (segmentMatch[3] || "").trim(),
    };
  }

  const plainMatch = normalized.match(/^((?:@\S+\s+)+)(\S+)([\s\S]*)$/i);
  if (!plainMatch) return undefined;

  const leadingAtSegments = (plainMatch[1] || "")
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.startsWith("@") && token.length > 1)
    .map((token) => {
      const mentionBody = token.slice(1).trim();
      return /^\d+$/.test(mentionBody)
        ? `<at id="${mentionBody}"/>`
        : `@${mentionBody}`;
    });

  const commandText = (plainMatch[2] || "").trim();
  if (leadingAtSegments.length === 0 || !commandText) return undefined;

  return {
    leadingAtSegments,
    commandText,
    suffix: (plainMatch[3] || "").trim(),
  };
}

function parseLeadingAtBeforeMemeByElements(
  elements: readonly ElementLike[] = [],
): LeadingAtCommandParts | undefined {
  if (elements.length < 2) return undefined;

  const atElements: ElementLike[] = [];
  let index = 0;
  for (; index < elements.length; index += 1) {
    const element = elements[index];
    if (element?.type !== "at") break;
    atElements.push(element);
  }

  if (atElements.length === 0) return undefined;

  let commandText = "";
  let suffix = "";
  let foundCommandText = false;
  for (; index < elements.length; index += 1) {
    const element = elements[index];
    if (element?.type !== "text") return undefined;

    const rawContent = element.attrs?.content;
    const textContent =
      typeof rawContent === "string" ? rawContent.trimStart() : "";
    if (!textContent) continue;

    const match = textContent.match(/^(\S+)([\s\S]*)$/i);
    if (!match) return undefined;

    commandText = (match[1] || "").trim();
    suffix = (match[2] || "").trim();
    foundCommandText = true;
    break;
  }

  if (!foundCommandText || !commandText) return undefined;

  const leadingAtSegments = atElements
    .map((element) => {
      const id = element.attrs?.id;
      return id ? `<at id="${id}"/>` : "";
    })
    .filter(Boolean);
  if (leadingAtSegments.length === 0) return undefined;

  return {
    leadingAtSegments,
    commandText,
    suffix,
  };
}

function collectChineseAliases(info: MemeInfoResponse): string[] {
  const aliases = [
    ...info.keywords,
    ...info.shortcuts.flatMap((shortcut) =>
      shortcut.humanized ? [shortcut.humanized, shortcut.key] : [shortcut.key],
    ),
  ]
    .map((alias) => alias.trim())
    .filter((alias) => alias && /[^\x00-\x7F]/.test(alias));

  return Array.from(new Set(aliases));
}

export function registerCommands(ctx: Context, settings: MemeSettings, client: MemeBackendClient) {
  // Process-level fields only; conversation behaviour is read per session through `settingsOf`.
  const config = settings.config;
  const settingsOf = (session?: Session): Config => settings.of(session);
  // Category exclusion needs every template's params; they load once a conversation turns a category on.
  let categoryParams: Map<string, MemeParamsType> | undefined;
  const ensureCategoryExcludedMemeKeySet = async (
    current: Config,
    rawKeys?: string[],
    forceRefresh = false,
  ): Promise<void> => {
    if (!hasCategoryExclusion(current)) return;
    if (categoryParams && !forceRefresh) return;
    const keys = rawKeys ?? (await client.getKeys());
    categoryParams = await fetchCategoryParams(client, keys, config);
  };
  const mergedExcludedMemeKeySet = (current: Config): Set<string> => {
    const excluded = excludedKeys(current);
    if (!categoryParams) return excluded;
    return new Set([...excluded, ...categoryExcludedKeys(categoryParams, current)]);
  };

  const resolveMemeKey = createMemeKeyResolver(client, {
    infoFetchConcurrency: config.infoFetchConcurrency,
  });
  const resolveMemeTriggerPrefix = createMemeTriggerPrefixResolver(client, {
    infoFetchConcurrency: config.infoFetchConcurrency,
  });
  const logger = ctx.logger;
  const memeCommand = ctx.command("meme");

  const handleErrorReply = (current: Config, scope: string, message: string): string => {
    if (!current.disableErrorReplyToPlatform) return message;
    logger.warn("%s failed: %s", scope, message);
    return "";
  };

  const handleRuntimeError = (current: Config, scope: string, error: unknown): string => {
    return handleErrorReply(current, scope, mapRuntimeErrorMessage(error));
  };

  ctx.middleware(async (session, next) => {
    const sessionTextContent = resolveSessionTextContent(session);
    if (/^<img\b/i.test(sessionTextContent)) {
      const commandText = sessionTextContent.replace(/<img\b[^>]*>(?:<\/img>)?/gi, " ").trim();
      if (/^meme(?:\.(?:list|info|preview|search|random))?(?:\s|$)/i.test(commandText)) {
        const result = await session.execute(commandText, true);
        if (result.length) await session.send(result);
        return;
      }
    }
    const strippedContent =
      typeof session.stripped?.content === "string"
        ? session.stripped.content.trim()
        : "";
    const sessionElements = Array.isArray(session.elements)
      ? (session.elements as ElementLike[])
      : [];
    const contentMatched = parseLeadingAtBeforeMemeCommand(sessionTextContent);
    const elementsMatched = parseLeadingAtBeforeMemeByElements(sessionElements);
    const leadingAtParts = contentMatched || elementsMatched;

    if (config.enableDeveloperDebugLog) {
      logger.info(
        "leading-at debug: content=%s stripped=%s contentMatched=%s elementsMatched=%s matched=%s allow=%s",
        JSON.stringify(sessionTextContent),
        JSON.stringify(strippedContent),
        String(Boolean(contentMatched)),
        String(Boolean(elementsMatched)),
        String(Boolean(leadingAtParts)),
        String(settingsOf(session).allowLeadingAtBeforeCommand),
      );
      logger.info(
        "leading-at debug: elements-count=%s elements-types=%s",
        String(sessionElements.length),
        JSON.stringify(sessionElements.map((element) => element?.type || "")),
      );
      if (contentMatched) {
        logger.info(
          "leading-at debug: content command=%s suffix=%s segments=%s",
          JSON.stringify(contentMatched.commandText),
          JSON.stringify(contentMatched.suffix),
          JSON.stringify(contentMatched.leadingAtSegments),
        );
      }
      if (elementsMatched) {
        logger.info(
          "leading-at debug: elements command=%s suffix=%s segments=%s",
          JSON.stringify(elementsMatched.commandText),
          JSON.stringify(elementsMatched.suffix),
          JSON.stringify(elementsMatched.leadingAtSegments),
        );
      }
    }

    if (!leadingAtParts) {
      if (config.enableDeveloperDebugLog) {
        logger.info("leading-at debug: pass-through middleware");
      }
      return await next();
    }

    const isMentioningSelf = Boolean(session.stripped?.atSelf) || leadingAtParts.leadingAtSegments.includes(`<at id="${session.selfId}"/>`);
    const isMemeCommand = /^meme$/i.test(leadingAtParts.commandText.trim());

    if (isMentioningSelf && !isMemeCommand) {
      if (config.enableDeveloperDebugLog) {
        logger.info("leading-at debug: pass-through at-self non-meme");
      }
      return await next();
    }

    const current = settingsOf(session);
    if (!current.allowLeadingAtBeforeCommand) {
      if (config.enableDeveloperDebugLog) {
        logger.info(
          "leading-at debug: pass-through because allowLeadingAtBeforeCommand=false",
        );
      }
      return await next();
    }

    const normalizedCommandText = leadingAtParts.commandText.trim();
    const normalizedSuffix = leadingAtParts.suffix.trim();
    // Koishi 会在 matcher 前过滤“@其他用户 别名”，此入口直接生成，不能依赖主命令开关。
    if (
      current.enableDirectAliasWithoutPrefix &&
      shouldRegisterDirectAlias(normalizedCommandText)
    ) {
      const resolvedKey = await resolveMemeKey(normalizedCommandText);
      if (resolvedKey !== normalizedCommandText) {
        let result;
        try {
          await ensureCategoryExcludedMemeKeySet(current);
          if (isExcludedMemeKey(resolvedKey, mergedExcludedMemeKeySet(current))) {
            result = handleErrorReply(current, "meme.generate", "该模板已被排除。");
          } else {
            // 仅复用父命令的参数解析，保留引号边界，不执行受开关控制的主命令。
            const { args = [], error } = memeCommand.parse(normalizedSuffix);
            result = error
              ? handleErrorReply(current, "meme.generate", error)
              : await handleGenerate(ctx, session, client, current, resolvedKey, args);
          }
        } catch (error) {
          result = handleRuntimeError(current, "meme.generate", error);
        }
        if (config.enableDeveloperDebugLog) {
          logger.info(
            "leading-at debug: alias=%s key=%s",
            JSON.stringify(normalizedCommandText),
            JSON.stringify(resolvedKey),
          );
        }
        if (result) await session.send(result);
        return;
      }
    }

    // 普通前置 @ 消息必须继续放行，避免把对话内容当成 meme key 后吞掉。
    if (!/^meme$/i.test(normalizedCommandText)) {
      if (config.enableDeveloperDebugLog) {
        logger.info("leading-at debug: pass-through non-meme command");
      }
      return await next();
    }

    const rewrittenCommand = normalizedSuffix
      ? `meme ${normalizedSuffix}`
      : "meme";

    if (config.enableDeveloperDebugLog) {
      logger.info(
        "leading-at debug: rewritten=%s",
        JSON.stringify(rewrittenCommand),
      );
    }

    const executed = await session.execute(rewrittenCommand, true);
    if (config.enableDeveloperDebugLog) {
      logger.info(
        "leading-at debug: execute returned=%s",
        JSON.stringify(executed),
      );
    }
    if (executed.length) await session.send(executed);
  }, true);

  const executePreview = async (
    key: string,
    session?: Session,
  ): Promise<string | ReturnType<typeof h.image>> => {
    const current = settingsOf(session);
    if (!key) return handleErrorReply(current, "meme.preview", "请提供模板 key。");

    try {
      await ensureCategoryExcludedMemeKeySet(current);
      const resolvedKey = await resolveMemeKey(key);
      if (isExcludedMemeKey(resolvedKey, mergedExcludedMemeKeySet(current))) {
        return handleErrorReply(current, "meme.preview", "该模板已被排除。");
      }
      const preview = await client.getPreview(resolvedKey);
      return h.image(Buffer.from(preview.buffer), preview.mimeType);
    } catch (error) {
      return handleRuntimeError(current, "meme.preview", error);
    }
  };

  ctx.command("meme.list", "列出可用 meme 模板").action(async ({ session }) => {
    const config = settingsOf(session);
    try {
      const rawKeys = await client.getKeys();
      await ensureCategoryExcludedMemeKeySet(config, rawKeys, true);
      const keys = filterExcludedMemeKeys(
        rawKeys,
        mergedExcludedMemeKeySet(config),
      );
      if (keys.length === 0)
        return replyOrSilent(
          config,
          logger,
          "meme.list",
          "当前后端没有可用模板。",
        );

      const infoResults = await fetchMemeListInfos(client, keys, config);
      const entries = buildMemeListEntries(
        infoResults,
        config.showMemeListKey,
      );
      const sections = buildMemeListSections(entries);
      const lines = formatMemeListLines(sections);
      if (lines.length === 0)
        return replyOrSilent(
          config,
          logger,
          "meme.list",
          "当前后端没有可用模板。",
        );

      if (!config.renderMemeListAsImage) {
        const chunks = splitMemeListMessages(sections);
        if (config.sendMemeListAsForward) {
          const sent = await sendMemeListForwardMessage(
            session,
            sections,
            logger,
          );
          if (sent) return;
        }
        if (session) {
          for (const chunk of chunks) {
            await session.send(chunk);
          }
          return;
        }
        return chunks.join("\n");
      }

      const images = await buildListImages(
        sections,
        config.memeListImageMode,
        logger,
        ctx.takumi,
        async (url) =>
          (await downloadImage(ctx, url, config.timeoutMs, "emoji")).data,
      );
      if (!images) return lines.join("\n");
      if (images.length > 1 && config.sendMemeListAsForward) {
        const sent = await sendMemeListImageForwardMessage(
          session,
          images,
          logger,
        );
        if (sent) return;
      }
      return formatMemeListImageMessage(images);
    } catch (error) {
      return handleRuntimeError(config, "meme.list", error);
    }
  });

  ctx
    .command("meme.search <关键词:string>", "搜索 meme 模板")
    .action(async ({ session }, keyword) => {
      const config = settingsOf(session);
      if (!keyword)
        return handleErrorReply(config, "meme.search", "用法：meme.search <关键词>");
      try {
        const rawKeys = await client.getKeys();
        await ensureCategoryExcludedMemeKeySet(config, rawKeys, true);
        const keys = filterExcludedMemeKeys(
          rawKeys,
          mergedExcludedMemeKeySet(config),
        );
        if (keys.length === 0)
          return replyOrSilent(
            config,
            logger,
            "meme.search",
            "当前后端没有可用模板。",
          );

        const infoResults = await fetchMemeListInfos(client, keys, config);
        const results = searchMemeInfos(infoResults, keyword);
        if (results.length === 0) return `未找到相关表情：${keyword}`;
        const message = formatMemeSearchResultMessage(results);
        if (
          config.sendMemeSearchAsForward &&
          (await sendMemeSearchForwardMessage(
            session,
            message,
            results.length,
            logger,
          ))
        ) {
          return;
        }
        return message;
      } catch (error) {
        return handleRuntimeError(config, "meme.search", error);
      }
    });

  ctx
    .command("meme.info <key:string>", "查看模板参数约束")
    .action(async ({ session }, key) => {
      const current = settingsOf(session);
      if (!key) return handleErrorReply(current, "meme.info", "请提供模板 key。");
      try {
        await ensureCategoryExcludedMemeKeySet(current);
        const resolvedKey = await resolveMemeKey(key);
        if (isExcludedMemeKey(resolvedKey, mergedExcludedMemeKeySet(current))) {
          return handleErrorReply(current, "meme.info", "该模板已被排除。");
        }
        const info = await client.getInfo(resolvedKey);
        const params = info.params_type;
        const aliases = collectChineseAliases(info);
        return [
          `key: ${info.key}`,
          `aliases: ${aliases.join(" | ") || "(无)"}`,
          `images: ${params.min_images} ~ ${params.max_images}`,
          `texts: ${params.min_texts} ~ ${params.max_texts}`,
          `default_texts: ${params.default_texts.join(" | ") || "(空)"}`,
        ].join("\n");
      } catch (error) {
        return handleRuntimeError(current, "meme.info", error);
      }
    });

  ctx
    .command("meme.preview <key:string>", "预览模板效果")
    .action(async ({ session }, key) => executePreview(key, session));

  const isExcludedFromMergedSet = (key: string, current: Config): boolean => {
    return isExcludedMemeKey(key, mergedExcludedMemeKeySet(current));
  };

  // Any conversation may turn the unprefixed triggers on, so aliases always register and each message checks its own settings.
  installDirectAliasRuntime({
    ctx,
    config,
    settingsOf,
    client,
    logger,
    ensureCategoryExcludedMemeKeySet,
    isExcludedMemeKey: isExcludedFromMergedSet,
    handleGenerate: async (session, current, key, texts) => {
      return await handleGenerate(ctx, session, client, current, key, texts);
    },
  });

  // 只控制主生成命令；关闭时不生成也不回复，meme.* 子命令照常可用。
  ctx
    .command("meme <key:string> [...texts]", "生成 meme 图片", {
      captureQuote: false,
    })
    .action(async ({ session }, key, ...texts) => {
      const current = settingsOf(session);
      if (!current.enableMemeCommandTrigger) return;
      if (!session)
        return handleErrorReply(current, "meme.generate", "当前上下文不可用。");
      try {
        await ensureCategoryExcludedMemeKeySet(current);
        // 贴合写法会把 key/中文别名和 @ 提及挤在同一个 Koishi 参数里，
        // 这里先拆出最长模板前缀，避免 @ 目标被后续逻辑误当成普通文本。
        const mergedTrigger = current.allowMentionPrefixDirectAliasTrigger
          ? await resolveMemeTriggerPrefix(key)
          : undefined;
        const resolvedKey = mergedTrigger?.key ?? (await resolveMemeKey(key));
        if (isExcludedMemeKey(resolvedKey, mergedExcludedMemeKeySet(current))) {
          return handleErrorReply(current, "meme.generate", "该模板已被排除。");
        }
        const mergedTexts = mergedTrigger
          ? [
              ...normalizeMergedTriggerRestText(
                mergedTrigger.rest,
                session,
              ),
              ...texts,
            ]
          : texts;
        return await handleGenerate(
          ctx,
          session,
          client,
          current,
          resolvedKey,
          mergedTexts,
        );
      } catch (error) {
        return handleRuntimeError(current, "meme.generate", error);
      }
    });

  installRandomRuntime({
    ctx,
    config,
    settingsOf,
    client,
    logger,
    ensureCategoryExcludedMemeKeySet,
    filterExcludedMemeKeys: (keys, current) =>
      filterExcludedMemeKeys(keys, mergedExcludedMemeKeySet(current)),
    handleErrorReply,
    handleRuntimeError,
  });
  return {
    client,
    resolveMemeKey,
    settings,
    /** Whether the conversation excludes the key, by key or by its template params. */
    isExcludedMemeKey: (key: string, current: Config) =>
      isExcludedFromMergedSet(key, current),
  };
}
