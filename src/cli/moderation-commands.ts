import { parseArgs } from 'node:util'

import { ModerationError, ModerationService, type LinkOutcome } from '@/modules/moderation/moderation.service'
import { UrlDisabledReason } from '@prisma-client'

const COMMANDS = ['link:disable', 'link:enable', 'user:suspend', 'user:unsuspend']

export const USAGE = `Usage:
  link:disable <code|url> [--unsafe] [--owner]   disable a link; --unsafe lets the owner lift it by
                                                 changing the destination, --owner also suspends the owner
  link:enable <code|url>                         re-enable a link
  user:suspend <email|code|url>                  suspend an account and disable its links
  user:unsuspend <email|code|url>                lift a suspension and re-enable the links it disabled`

function describeLink(outcome: LinkOutcome, verb: string): string {
  if (!outcome.changed) {
    return `Link ${outcome.shortCode} unchanged (${outcome.disabledReason ?? 'enabled'})`
  }
  const state = outcome.disabledReason === null ? verb : `${verb} (${outcome.disabledReason})`
  return `Link ${outcome.shortCode} ${state}; owner ${outcome.ownerEmail ?? 'none'}`
}

export interface ModerationCommand {
  command: string
  target: string
  owner: boolean
  unsafe: boolean
}

/** Parses `argv` (without the node and script paths). Throws `ModerationError` with the usage on bad input. */
export function parseModerationCommand(argv: string[]): ModerationCommand {
  try {
    const { positionals, values } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { owner: { type: 'boolean' }, unsafe: { type: 'boolean' } },
    })
    const [command, target, ...extra] = positionals
    if (command === undefined || target === undefined || extra.length > 0) {
      throw new Error('Expected a command and one target')
    }
    if (!COMMANDS.includes(command)) {
      throw new Error(`Unknown command "${command}"`)
    }
    if ((values.owner || values.unsafe) && command !== 'link:disable') {
      throw new Error('--owner and --unsafe apply to link:disable only')
    }
    return { command, target, owner: values.owner === true, unsafe: values.unsafe === true }
  } catch (error) {
    throw new ModerationError(`${(error as Error).message}\n\n${USAGE}`)
  }
}

/** Runs one parsed command and returns the lines to print. Throws `ModerationError` for an unknown target. */
export async function runModerationCommand(
  moderation: ModerationService,
  { command, target, owner, unsafe }: ModerationCommand,
): Promise<string[]> {
  switch (command) {
    case 'link:disable': {
      const shortCode = moderation.shortCodeOf(target)
      const reason = unsafe ? UrlDisabledReason.UNSAFE_DESTINATION : UrlDisabledReason.MANUAL
      const lines = [describeLink(await moderation.disableLink(shortCode, reason), 'disabled')]
      if (owner) {
        const user = await moderation.suspendUser(await moderation.findUserId(shortCode))
        lines.push(describeSuspension(user.email, user.changed, user.shortCodes.length, 'suspended'))
      }
      return lines
    }
    case 'link:enable':
      return [describeLink(await moderation.enableLink(moderation.shortCodeOf(target)), 'enabled')]
    case 'user:suspend': {
      const user = await moderation.suspendUser(await moderation.findUserId(target))
      return [describeSuspension(user.email, user.changed, user.shortCodes.length, 'suspended')]
    }
    case 'user:unsuspend': {
      const user = await moderation.unsuspendUser(await moderation.findUserId(target))
      return [describeSuspension(user.email, user.changed, user.shortCodes.length, 'restored')]
    }
    default:
      throw new ModerationError(`Unknown command "${command}"`)
  }
}

function describeSuspension(email: string, changed: boolean, links: number, verb: string): string {
  if (!changed) {
    return verb === 'suspended' ? `Account ${email} already suspended` : `Account ${email} is not suspended`
  }
  const what = verb === 'suspended' ? 'disabled' : 're-enabled'
  return `Account ${email} ${verb}; ${links} link(s) ${what}`
}
