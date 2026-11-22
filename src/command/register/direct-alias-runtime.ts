/**
 * 直连别名运行时
 * 负责别名匹配、注册重试与生命周期清理
 */

import type { Context } from "cordis";
import { h, type Session } from "@satorijs/core";
import type {} from "koishi";
import type { Config } from "../../config";
import { MemeBackendClient } from "../../backend";
import { listDirectAliases, shouldRegisterDirectAlias } from "../key-resolver";
import type { ElementLike } from "./types";

function collectMentionTokens(session: Session): string[] {
  const mentionTokens: string[] = [];

  const appendMentionToken = (value: unknown): void => {
    if (typeof value !== "string" && typeof value !== "number") return;
    const normalizedValue = String(value).trim();
    if (!normalizedValue) return;
    mentionTokens.push(`@${normalizedValue}`);
  };

  const walk = (elements: readonly ElementLike[]): void => {
    for (const element of elements) {
      if (element.type === "at") {
        appendMentionToken(element.attrs?.id);
        appendMentionToken(element.attrs?.name);
      }
      if (element.children?.length) walk(element.children);
    }
  };

  if (Array.isArray(session.elements)) {
    walk(session.elements as ElementLike[]);
  }

  return mentionTokens.sort((left, right) => right.length - left.length);
}

function removeFirstOccurrence(source: string, target: string): string {
  const index = source.indexOf(target);
  if (index < 0) return source;
  return `${source.slice(0, index)} ${source.slice(index + target.length)}`;
}

export function normalizeMergedTriggerRestText(
  rest: string,
  session: Session,
): string[] {
  let normalizedRest = rest
    .replace(/^\s+/, "")
    .replace(/<at\b[^>]*>(?:<\/at>)?/gi, " ");

  for (const mentionToken of collectMentionTokens(session)) {
    normalizedRest = removeFirstOccurrence(normalizedRest, mentionToken);
  }

  normalizedRest = normalizedRest.trim();
  if (!normalizedRest) return [];

  return normalizedRest
    .split(/\s+/)
    .map((text) => text.trim())
    .filter(Boolean);
}

function extractDirectAliasTexts(
  session: Session,
  alias: string,
  allowMergedSuffix: boolean,
  allowLeadingAtBeforeCommand: boolean,
): string[] | undefined {
  if (!allowLeadingAtBeforeCommand && session.stripped?.atSelf)
    return undefined;

  const strippedContent = session.stripped?.content;
  if (typeof strippedContent !== "string") return undefined;

  const content = strippedContent.trim();
  if (!content.startsWith(alias)) return undefined;

  const rest = content.slice(alias.length);
  if (!rest) return [];
  if (!allowMergedSuffix && !/^\s/.test(rest)) return undefined;

  return normalizeMergedTriggerRestText(rest, session);
}

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createMergedDirectAliasPattern(alias: string): RegExp {
  return new RegExp(`^${escapeRegExp(alias)}[\\s\\S]*$`);
}

export function resolveFirstDirectAlias(
  keywords: string[],
  shortcuts: Array<{ key: string; humanized?: string }>,
): string | undefined {
  const aliases = [
    ...keywords,
    ...shortcuts.flatMap((shortcut) =>
      shortcut.humanized ? [shortcut.key, shortcut.humanized] : [shortcut.key],
    ),
  ]
    .map((alias) => alias.trim())
    .filter(Boolean)
    .filter((alias) => shouldRegisterDirectAlias(alias));

  return aliases.find(
    (alias) => /[^\x00-\x7F]/.test(alias) && alias.length >= 2,
  );
}

interface InstallDirectAliasRuntimeOptions {
  ctx: Context;
  /** Process-level fields: retries, fetch concurrency and debug logging. */
  config: Config;
  settingsOf: (session?: Session) => Config;
  client: MemeBackendClient;
  logger: Context["logger"];
  ensureCategoryExcludedMemeKeySet: (current: Config) => Promise<void>;
  isExcludedMemeKey: (key: string, current: Config) => boolean;
  handleGenerate: (
    session: Session,
    current: Config,
    key: string,
    texts: string[],
  ) => Promise<string | ReturnType<typeof h.image>>;
}

export function installDirectAliasRuntime(
  options: InstallDirectAliasRuntimeOptions,
): void {
  const {
    ctx,
    config,
    settingsOf,
    client,
    logger,
    ensureCategoryExcludedMemeKeySet,
    isExcludedMemeKey,
    handleGenerate,
  } = options;

  const directAliasMatchDisposers = new Map<string, () => void>();
  const registeredAliasKeySignatures = new Map<string, string>();
  const duplicatedAliasSignatures = new Map<string, string>();
  let aliasRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let aliasRetryAttempts = 0;
  let aliasRetryRunning = false;
  let aliasRetryDisposed = false;

  const maxAliasRetryAttempts = config.initLoadRetryTimes;
  let initializedNotified = false;

  const registerDirectAliases = async (): Promise<boolean> => {
    if (aliasRetryDisposed) return true;
    // Both alias kinds register; the conversation's switches decide per message which of them trigger.
    const result = await listDirectAliases(client, {
      infoFetchConcurrency: config.infoFetchConcurrency,
      enableDirectAliasWithoutPrefix: true,
      allowKeyWithoutPrefixTrigger: true,
    });
    // Preloads category params when the rules matching everywhere exclude a category.
    await ensureCategoryExcludedMemeKeySet(settingsOf());
    if (aliasRetryDisposed) return true;
    if (!initializedNotified) {
      initializedNotified = true;
      logger.info("Loaded %d memes", result.totalKeys);
    }
    let registeredCount = 0;
    let updatedCount = 0;
    let removedCount = 0;

    const sortedEntries = [...result.entries].sort(
      (left, right) => right.alias.length - left.alias.length,
    );
    const activeAliases = new Set<string>();

    const duplicatedAliasEntries = sortedEntries.filter(
      (entry) => entry.keys.length > 1,
    );
    const duplicatedAliasSet = new Set(
      duplicatedAliasEntries.map((entry) => entry.alias),
    );
    for (const existingAlias of duplicatedAliasSignatures.keys()) {
      if (!duplicatedAliasSet.has(existingAlias)) {
        duplicatedAliasSignatures.delete(existingAlias);
      }
    }
    for (const duplicatedEntry of duplicatedAliasEntries) {
      const duplicatedSignature = duplicatedEntry.keys.join("\u0000");
      if (
        duplicatedAliasSignatures.get(duplicatedEntry.alias) ===
        duplicatedSignature
      ) {
        continue;
      }

      duplicatedAliasSignatures.set(duplicatedEntry.alias, duplicatedSignature);
      logger.warn(
        "detected duplicate direct alias: %s -> %s",
        duplicatedEntry.alias,
        duplicatedEntry.keys.join(", "),
      );
    }

    for (const entry of sortedEntries) {
      if (!entry.isKeyAlias && !shouldRegisterDirectAlias(entry.alias)) continue;
      if (ctx.$commander.get(entry.alias)) continue;

      const aliasKeys = entry.keys.filter(Boolean);
      if (aliasKeys.length === 0) continue;
      activeAliases.add(entry.alias);

      const aliasKeySignature = aliasKeys.join("\u0000");
      const registeredSignature = registeredAliasKeySignatures.get(entry.alias);
      if (registeredSignature === aliasKeySignature) continue;

      const previousDispose = directAliasMatchDisposers.get(entry.alias);
      if (previousDispose) {
        previousDispose();
        updatedCount += 1;
      } else {
        registeredCount += 1;
      }

      // The merged pattern accepts everything the strict one does; the filter applies the conversation's choice.
      const directAliasPattern = createMergedDirectAliasPattern(entry.alias);
      const isKeyAlias = entry.isKeyAlias === true;
      const textsOf = (session: Session, current: Config) =>
        extractDirectAliasTexts(
          session,
          entry.alias,
          current.allowMentionPrefixDirectAliasTrigger,
          current.allowLeadingAtBeforeCommand,
        );

      // A conversation that turned this alias kind off, or excludes all its templates, keeps the message for normal chat.
      const matcherContext = ctx.intersect((session: Session) => {
        if (!session.stripped?.content?.trim().startsWith(entry.alias)) return false;
        const current = settingsOf(session);
        const enabled = isKeyAlias
          ? current.allowKeyWithoutPrefixTrigger
          : current.enableDirectAliasWithoutPrefix;
        return (
          enabled &&
          textsOf(session, current) !== undefined &&
          aliasKeys.some((key) => !isExcludedMemeKey(key, current))
        );
      });

      const disposeMatch = matcherContext.$processor.match(
        directAliasPattern,
        async (session: Session) => {
          const current = settingsOf(session);
          if (config.enableDeveloperDebugLog) {
            logger.info(
              "direct-alias debug: alias=%s stripped=%s atSelf=%s hasAt=%s appel=%s allowLeadingAt=%s",
              entry.alias,
              JSON.stringify(session.stripped?.content || ""),
              String(Boolean(session.stripped?.atSelf)),
              String(Boolean(session.stripped?.hasAt)),
              String(Boolean(session.stripped?.appel)),
              String(current.allowLeadingAtBeforeCommand),
            );
          }

          const directAliasTexts = textsOf(session, current);
          if (!directAliasTexts) {
            if (config.enableDeveloperDebugLog) {
              logger.info(
                "direct-alias debug: bypass/skip alias=%s",
                entry.alias,
              );
            }
            return "";
          }

          await ensureCategoryExcludedMemeKeySet(current);
          const availableAliasKeys = aliasKeys.filter(
            (key) => !isExcludedMemeKey(key, current),
          );
          if (availableAliasKeys.length === 0) {
            if (!current.disableErrorReplyToPlatform) return "该模板已被排除。";
            logger.warn("direct-alias skipped reply: %s", "该模板已被排除。");
            return "";
          }

          const pickedKey =
            availableAliasKeys.length === 1
              ? availableAliasKeys[0]
              : availableAliasKeys[
                  Math.floor(Math.random() * availableAliasKeys.length)
                ];

          if (config.enableDeveloperDebugLog) {
            logger.info(
              "direct-alias debug: trigger alias=%s key=%s texts=%s",
              entry.alias,
              pickedKey,
              JSON.stringify(directAliasTexts),
            );
          }

          return (
            (await handleGenerate(session, current, pickedKey, directAliasTexts)) ?? ""
          );
        },
        {
          appel: false,
          i18n: false,
          fuzzy: false,
        },
      );

      directAliasMatchDisposers.set(entry.alias, disposeMatch);
      registeredAliasKeySignatures.set(entry.alias, aliasKeySignature);
    }

    for (const [alias, disposeMatch] of directAliasMatchDisposers.entries()) {
      if (activeAliases.has(alias)) continue;
      disposeMatch();
      directAliasMatchDisposers.delete(alias);
      registeredAliasKeySignatures.delete(alias);
      duplicatedAliasSignatures.delete(alias);
      removedCount += 1;
    }

    logger.info(
      "registered direct aliases: %d (new: %d, updated: %d, removed: %d, duplicated aliases: %d, failed info keys: %d/%d)",
      directAliasMatchDisposers.size,
      registeredCount,
      updatedCount,
      removedCount,
      duplicatedAliasEntries.length,
      result.failedInfoKeys,
      result.totalKeys,
    );

    return !result.hasInfoFailure;
  };

  const clearAliasRetryTimer = (): void => {
    if (aliasRetryTimer) {
      clearTimeout(aliasRetryTimer);
      aliasRetryTimer = undefined;
    }
  };

  const stopAliasRetry = (): void => {
    clearAliasRetryTimer();
    aliasRetryRunning = false;
  };

  const scheduleAliasRetry = (delayMs: number): void => {
    if (aliasRetryDisposed) return;
    if (aliasRetryRunning && aliasRetryTimer) return;
    if (aliasRetryAttempts >= maxAliasRetryAttempts) {
      logger.warn(
        "direct alias retry stopped after %d attempts",
        aliasRetryAttempts,
      );
      stopAliasRetry();
      return;
    }

    aliasRetryRunning = true;
    aliasRetryTimer = setTimeout(() => {
      if (aliasRetryDisposed) {
        aliasRetryTimer = undefined;
        return;
      }
      aliasRetryTimer = undefined;
      aliasRetryAttempts += 1;

      void registerDirectAliases()
        .then((isComplete) => {
          if (aliasRetryDisposed) {
            stopAliasRetry();
            return;
          }
          if (isComplete) {
            aliasRetryAttempts = 0;
            stopAliasRetry();
            return;
          }

          logger.warn(
            "direct alias list still incomplete (attempt %d/%d), scheduling retry",
            aliasRetryAttempts,
            maxAliasRetryAttempts,
          );
          scheduleAliasRetry(3000);
        })
        .catch((retryError) => {
          if (aliasRetryDisposed) {
            stopAliasRetry();
            return;
          }
          logger.warn(
            "failed to register direct aliases on retry (attempt %d/%d): %s",
            aliasRetryAttempts,
            maxAliasRetryAttempts,
            String(retryError),
          );
          scheduleAliasRetry(3000);
        });
    }, delayMs);
  };

  {
    aliasRetryDisposed = false;
    aliasRetryAttempts = 0;
    stopAliasRetry();

    void registerDirectAliases()
      .then((isComplete) => {
        if (!isComplete) {
          logger.warn(
            "direct alias list is incomplete at startup, scheduling retry",
          );
          scheduleAliasRetry(3000);
        }
      })
      .catch((error) => {
        logger.warn(
          "failed to register direct aliases at startup: %s",
          String(error),
        );
        scheduleAliasRetry(3000);
      });
  }

  ctx.effect(() => () => {
    aliasRetryDisposed = true;
    stopAliasRetry();
    for (const disposeMatch of directAliasMatchDisposers.values()) {
      disposeMatch();
    }
    directAliasMatchDisposers.clear();
    registeredAliasKeySignatures.clear();
    duplicatedAliasSignatures.clear();
  });
}
