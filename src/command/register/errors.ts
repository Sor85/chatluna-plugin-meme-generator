import type { Context } from 'cordis'
import type { Config } from '../../config'

export function mapRuntimeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function replyOrSilent(config: Config, logger: Context['logger'], scope: string, message: string): string {
  if (!config.disableErrorReplyToPlatform) return message
  logger.warn('%s skipped reply: %s', scope, message)
  return ''
}
