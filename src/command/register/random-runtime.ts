/**
 * random 运行时
 * 负责随机模板筛选与去重逻辑
 */

import type { Context } from "cordis";
import { h, type Session } from "@satorijs/core";
import type {} from "koishi";
import type { Config } from "../../config";
import { applyAutoFillPolicy } from "../../domain/policy";
import { MemeBackendClient } from "../../backend";
import { parseCommandInput } from "../parse";
import {
  createShuffledKeys,
  getRandomCandidatesWithDedupe,
  pickRandomBucketByWeight,
  pickRandomItem,
  recordRandomSelection,
  resolveRandomMemeBucket,
} from "../random";
import {
  getBotAvatarImage,
  getMentionedAvatarImages,
  getMentionedTargetDisplayName,
  getSenderAvatarImage,
  resolveSenderDisplayName,
} from "../../utils/avatar";
import {
  buildRandomConfig,
  handleGenerateWithPreparedInput,
} from "./generate";
import { mapRuntimeErrorMessage, replyOrSilent } from "./errors";
import { resolveFirstDirectAlias } from "./direct-alias-runtime";

interface InstallRandomRuntimeOptions {
  ctx: Context;
  /** Process-level fields: `randomOutputMemeKey` and request timeouts. */
  config: Config;
  settingsOf: (session: Session) => Config;
  client: MemeBackendClient;
  logger: Context["logger"];
  ensureCategoryExcludedMemeKeySet: (current: Config) => Promise<void>;
  filterExcludedMemeKeys: (keys: string[], current: Config) => string[];
  handleErrorReply: (current: Config, scope: string, message: string) => string;
  handleRuntimeError: (current: Config, scope: string, error: unknown) => string;
}

export function installRandomRuntime(
  options: InstallRandomRuntimeOptions,
): void {
  const {
    ctx,
    settingsOf,
    client,
    logger,
    ensureCategoryExcludedMemeKeySet,
    filterExcludedMemeKeys,
    handleErrorReply,
    handleRuntimeError,
  } = options;

  let randomSelectionHistory = new Map<string, number>();
  let randomSelectionQueue: Promise<void> = Promise.resolve();

  const withRandomSelectionLock = async <T>(
    task: () => Promise<T>,
  ): Promise<T> => {
    const previous = randomSelectionQueue;
    let releaseLock: (() => void) | undefined;
    randomSelectionQueue = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    await previous;
    try {
      return await task();
    } finally {
      releaseLock?.();
    }
  };

  const runRandomMeme = async (
    session: Session,
    texts: string[],
  ): Promise<string | ReturnType<typeof h.image>> => {
    const config = settingsOf(session);
    try {
      await ensureCategoryExcludedMemeKeySet(config);
      const executeRandom = async () => {
        const requestedRandomKey = config.randomOutputMemeKey.trim();
        // 开发者模式用于复现单个模板问题，非空时直接绕过随机候选列表。
        const filteredShuffledKeys = requestedRandomKey
          ? [requestedRandomKey]
          : filterExcludedMemeKeys(
              createShuffledKeys(await client.getKeys()),
              config,
            );
        if (filteredShuffledKeys.length === 0) {
          return replyOrSilent(
            config,
            logger,
            "meme.random",
            "当前后端没有可用模板。",
          );
        }

        const parsedInput = await parseCommandInput(
          ctx,
          session,
          texts,
          config,
        );
        const senderName = await resolveSenderDisplayName(session);
        const groupNicknameEnabled =
          config.autoUseGroupNicknameWhenNoDefaultText;
        const targetDisplayName = groupNicknameEnabled
          ? await getMentionedTargetDisplayName(session)
          : undefined;
        const groupNicknameText = groupNicknameEnabled
          ? targetDisplayName || senderName
          : undefined;

        const senderAvatarImage = await getSenderAvatarImage(
          ctx,
          session,
          config.timeoutMs,
        );
        const mentionedAvatarImages = await getMentionedAvatarImages(
          ctx,
          session,
          config.timeoutMs,
        );
        const botAvatarImage = await getBotAvatarImage(
          ctx,
          session,
          config.timeoutMs,
        );
        const randomConfig = buildRandomConfig(config);
        const randomDedupeConfig = {
          enabled: config.enableRandomDedupeWithinHours,
          windowHours: config.randomDedupeWindowHours,
        };
        const eligibleCandidates: Array<{
          key: string;
          bucketCategory: ReturnType<typeof resolveRandomMemeBucket>;
          selectedTextSource?: "template-default" | "user-nickname";
          directAlias?: string;
        }> = [];
        let infoFailedCount = 0;

        for (const key of filteredShuffledKeys) {
          try {
            const info = await client.getInfo(key);
            const finalInput = applyAutoFillPolicy({
              texts: parsedInput.texts,
              images: parsedInput.images,
              params: info.params_type,
              config: randomConfig,
              senderAvatarImage,
              mentionedAvatarImages,
              botAvatarImage,
              senderName,
              groupNicknameText,
            });

            const imageCount = finalInput.images.length;
            const textCount = finalInput.texts.length;
            const imageMatch =
              imageCount >= info.params_type.min_images &&
              imageCount <= info.params_type.max_images;
            const textMatch =
              textCount >= info.params_type.min_texts &&
              textCount <= info.params_type.max_texts;
            if (imageMatch && textMatch) {
              eligibleCandidates.push({
                key,
                bucketCategory: resolveRandomMemeBucket(info.params_type),
                selectedTextSource:
                  finalInput.selectedTextSource === "group-nickname"
                    ? undefined
                    : finalInput.selectedTextSource,
                directAlias: resolveFirstDirectAlias(
                  info.keywords,
                  info.shortcuts,
                ),
              });
            }
          } catch (error) {
            infoFailedCount += 1;
            logger.warn("meme.random skip key %s: %s", key, String(error));
          }
        }

        const dedupeResult = getRandomCandidatesWithDedupe(
          eligibleCandidates,
          randomSelectionHistory,
          randomDedupeConfig,
        );

        let historyForRecord = dedupeResult.history;
        let candidatesForPick = dedupeResult.candidates;
        if (
          randomDedupeConfig.enabled &&
          eligibleCandidates.length > 0 &&
          candidatesForPick.length === 0
        ) {
          // 只让当前输入条件下的候选轮回，不能清空全局历史。
          // 否则一个小候选子集耗尽时，会让其他模板提前失去时间窗口保护。
          candidatesForPick = eligibleCandidates;
        }

        let remainingCandidates = candidatesForPick;
        let lastFailedKey: string | undefined;
        let lastRuntimeMessage: string | undefined;

        while (remainingCandidates.length > 0) {
          const pickedBucket = pickRandomBucketByWeight(
            remainingCandidates,
            config.randomMemeBucketWeightRules,
          );
          const randomCandidate = pickRandomItem(
            pickedBucket?.candidates ?? [],
          );
          if (!randomCandidate) break;

          try {
            logger.info("meme trigger key: %s", randomCandidate.key);
            const result = await handleGenerateWithPreparedInput(
              client,
              randomConfig,
              randomCandidate.key,
              parsedInput.texts,
              parsedInput.images,
              senderAvatarImage,
              mentionedAvatarImages,
              botAvatarImage,
              senderName,
              groupNicknameText,
              randomCandidate.selectedTextSource,
            );

            randomSelectionHistory = recordRandomSelection(
              historyForRecord,
              randomCandidate.key,
              randomDedupeConfig,
            );

            if (config.enableRandomKeywordNotice) {
              const aliasText = randomCandidate.directAlias || "（无中文别名）";
              return [
                `key：${randomCandidate.key}`,
                `别名：${aliasText}`,
                String(result),
              ].join("\n");
            }

            return result;
          } catch (error) {
            lastFailedKey = randomCandidate.key;
            lastRuntimeMessage = mapRuntimeErrorMessage(error);
            logger.warn(
              "meme.random generate failed for key %s: %s",
              randomCandidate.key,
              lastRuntimeMessage,
            );
            remainingCandidates = remainingCandidates.filter(
              (candidate) => candidate.key !== randomCandidate.key,
            );
          }
        }

        if (candidatesForPick.length === 0) {
          if (infoFailedCount === filteredShuffledKeys.length) {
            return handleErrorReply(
              config,
              "meme.random",
              "随机筛选失败：后端不可用或超时，请稍后重试。",
            );
          }
          return replyOrSilent(
            config,
            logger,
            "meme.random",
            "未找到符合当前输入条件的随机模板，请补充图片或文字后重试。",
          );
        }

        if (config.disableErrorReplyToPlatform) {
          logger.warn(
            "meme.random failed: %s",
            lastRuntimeMessage ?? "未知错误",
          );
          return "";
        }
        return [
          `random key: ${lastFailedKey ?? "unknown"}`,
          lastRuntimeMessage ?? "生成失败，请稍后重试。",
        ].join("\n");
      };

      if (!config.enableRandomDedupeWithinHours) {
        return await executeRandom();
      }

      return await withRandomSelectionLock(executeRandom);
    } catch (error) {
      return handleRuntimeError(config, "meme.random", error);
    }
  };

  ctx
    .command("meme.random [...texts]", "随机选择模板并生成 meme 图片", {
      captureQuote: false,
    })
    .action(async ({ session }, ...texts) => {
      if (!session)
        return handleErrorReply(options.config, "meme.random", "当前上下文不可用。");
      return await runRandomMeme(session, texts);
    });
}
