#!/usr/bin/env -S node --no-warnings=ExperimentalWarning
import { time, timeEnd } from 'console'
import { actions, createCli, resolveAction } from './cli-lib.js'

const cli = createCli(import.meta)
const resolution = resolveAction(cli.input, cli.flags)

if ('error' in resolution) {
  cli.showHelp()
  console.error(resolution.error)
  process.exit(1)
}

try {
  time(resolution.action)
  await actions[resolution.action]()
  timeEnd(resolution.action)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
