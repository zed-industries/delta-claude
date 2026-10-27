/**
 * A single update row inside the status band. It never takes keyboard focus or starts a
 * model turn. Updating and notification preferences use the same handler as the slash command.
 */
import type { Host } from '../core/host'
import { installation } from '../core/installation'
import { isAskingOwnQuestion } from '../setup/interaction'
import { type HookEvent, requests } from '../core/session-state'
import { pluginUpdateCommand, snoozePluginUpdate } from '../plugin-update/updates'
import { pluginUpdateRow } from './status'
import { errorText } from '../core/text'

type Notice = {
  session: string
  branch: 'main' | 'develop'
  runningVersion: string
  version: string
  ready: boolean
}
let notice: Notice | undefined

/** Refreshing an already-visible notice must not redisplay one the person dismissed. */
export function showPluginUpdateNotice(host: Host, value: Notice, onlyIfShown = false) {
  if (onlyIfShown && notice?.session !== value.session) return
  notice = value
  host.ui.invalidate()
}

export function clearPluginUpdateNotice(host: Host, session: string) {
  if (notice?.session !== session) return
  notice = undefined
  host.ui.invalidate()
}

async function runNoticeCommand(host: Host, shown: Notice, args: string) {
  if (notice !== shown || await host.session.id() !== shown.session) return
  // Use the command's handler directly: a call back into our own command from a rendered callback
  // can skip that handler as a re-entry. Installation and activation still have one implementation.
  const result = await pluginUpdateCommand(host, args)
  if (result.text) await host.ui.log(result.text, { to: 'transcript' })
}

async function reportNoticeFailure(host: Host, error: unknown) {
  await host.ui.log(`Delta plugin update: ${errorText(error)}`, { to: 'transcript' })
}

export async function drawPluginUpdateNotice(
  host: Host, e: HookEvent<'ui.render', { component: 'AbovePrompt' }>, columns: number,
) {
  const shown = notice
  if (!shown || e.props.isWorking || installation ||
      requests.join || requests.share || isAskingOwnQuestion() || await host.session.id() !== shown.session)
    return null
  const row = pluginUpdateRow(shown.version, shown.ready, columns, (await host.session.surfaces()).includes('terminal'))
  if (!row) return null
  const { Box, Text, Button } = host.ui.resolve(e)
  const color = shown.ready ? 'green' : 'cyan'
  return <Box key="plugin-update-row" flexDirection="row" columnGap={1} height={1}>
    <Box width={row.summaryColumns} flexShrink={0}>
      <Text wrap="truncate-end">
        <Text color={color}>{shown.ready ? '✓ ' : '↑ '}</Text>
        <Text dimColor>{row.prefix}</Text>
        <Text color={color} bold>{row.version}</Text>
      </Text>
    </Box>
    <Box flexDirection="row" columnGap={1} flexShrink={0}>
      <Button key="plugin-update" label={row.action}
        onPress={() => { void runNoticeCommand(host, shown, '').catch((error) => reportNoticeFailure(host, error)) }}>
        <Text color={color} bold>{row.action}</Text>
      </Button>
      {row.later ? <Button key="plugin-update-later" dimColor label="Later"
        onPress={() => {
          void snoozePluginUpdate(host, shown.session, shown.branch, shown.version)
            .catch((error) => reportNoticeFailure(host, error))
        }} /> : null}
      {row.mute ? <Button key="plugin-update-off" dimColor label="Mute"
        onPress={() => {
          void runNoticeCommand(host, shown, 'notifications off').catch((error) => reportNoticeFailure(host, error))
        }} /> : null}
    </Box>
  </Box>
}
