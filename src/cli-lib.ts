import meow from 'meow'

import { build, publish, patch, minor, major } from './rage.js'

export const actions = {
  build,
  patch,
  minor,
  major,
  publish
} as const

export type ActionName = keyof typeof actions

type ActionFlags = {
  [Key in ActionName]: boolean | undefined
} & {
  all?: boolean
  log?: boolean
  otp?: string
}

type CliResolution =
  | {
      action: ActionName
    }
  | {
      error: string
      showHelp: boolean
    }

const helpText = `
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
`

export const actionNames = Object.keys(actions) as ActionName[]

export const isActionName = (value: string): value is ActionName => actionNames.includes(value as ActionName)

export const createCli = (importMeta: ImportMeta, argv = process.argv.slice(2)) =>
  meow(helpText, {
    importMeta,
    argv,
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
  })

export const resolveAction = (input: string[], flags: ActionFlags): CliResolution => {
  const command = input[0]
  const selectedFlagActions = actionNames.filter((actionName) => flags[actionName])

  if (selectedFlagActions.length > 1) {
    return {
      error: `Choose a single action flag: ${selectedFlagActions.map((action) => `--${action}`).join(', ')}`,
      showHelp: true
    }
  }

  if (command && !isActionName(command)) {
    return {
      error: `Unknown command: ${command}`,
      showHelp: true
    }
  }

  if (command && selectedFlagActions.length > 0) {
    return {
      error: 'Use either a command or an action flag, not both',
      showHelp: true
    }
  }

  const action: ActionName | undefined = command && isActionName(command) ? command : selectedFlagActions[0]

  if (!action) {
    return {
      error: 'No action provided',
      showHelp: true
    }
  }

  return { action }
}
