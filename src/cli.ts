#!/usr/bin/env -S node --no-warnings=ExperimentalWarning
import { time, timeEnd } from 'console'
import { build, publish, patch, minor, major } from './rage.js'

import meow from 'meow'

const actions = {
  build,
  patch,
  minor,
  major,
  publish
} as const

type ActionName = keyof typeof actions

const actionNames = Object.keys(actions) as ActionName[]

const isActionName = (value: string): value is ActionName => actionNames.includes(value as ActionName)

const cli = meow(
  `
    Usage
      $ rage <command> [options]
      $ rage --build [options]

    Commands
      build     Build changed projects
      patch     Bump patch versions for changed exports
      minor     Bump minor versions for changed exports
      major     Bump major versions for changed exports
      publish   Publish changed packages

    Options
      --build, -b     Build changed projects
      --patch, -p     Bump patch versions for changed exports
      --minor, -m     Bump minor versions for changed exports
      --major, -M     Bump major versions for changed exports
      --publish       Publish changed packages
      --all, -a       Run against all projects instead of changed ones
      --log, -l       Stream child build output
      --otp <code>    Pass an npm OTP when publishing

    Examples
      $ rage build
      $ rage publish --otp 123456
      $ rage --build --all --log
`,
  {
    importMeta: import.meta,
    booleanDefault: undefined,
    flags: {
      build: {
        type: 'boolean',
        shortFlag: 'b'
      },
      patch: {
        type: 'boolean',
        shortFlag: 'p'
      },
      minor: {
        type: 'boolean',
        shortFlag: 'm'
      },
      major: {
        type: 'boolean',
        shortFlag: 'M'
      },
      publish: {
        type: 'boolean'
      },
      all: {
        type: 'boolean',
        shortFlag: 'a'
      },
      log: {
        type: 'boolean',
        shortFlag: 'l'
      },
      otp: {
        type: 'string'
      }
    }
  }
)

const command = cli.input[0]
const selectedFlagActions = actionNames.filter((actionName) => cli.flags[actionName])

if (selectedFlagActions.length > 1) {
  cli.showHelp()
  throw new Error(`Choose a single action flag: ${selectedFlagActions.map((action) => `--${action}`).join(', ')}`)
}

if (command && !isActionName(command)) {
  cli.showHelp()
  throw new Error(`Unknown command: ${command}`)
}

if (command && selectedFlagActions.length > 0) {
  cli.showHelp()
  throw new Error('Use either a command or an action flag, not both')
}

const action: ActionName | undefined = command && isActionName(command) ? command : selectedFlagActions[0]

if (!action) {
  cli.showHelp()
  process.exit(1)
}

try {
  time(action)
  await actions[action]()
  timeEnd(action)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
