#!/usr/bin/env -S node --no-warnings=ExperimentalWarning
import { log, time, timeEnd } from 'console'
import { build, publish, patch, minor, major } from './rage.js'

import meow from 'meow'

const cli = meow(
  `
	Usage
	  $ foo

	Options
	  --build, -b  Build the project('s)
	  --patch, -p  Check if there are any changes in the project('s) exports and release a new patch version
    --minor, -m  Check if there are any changes in the project('s) exports and release a new minor version
    --major, -M  Check if there are any changes in the project('s) exports and release a new major version
    --publish, -pub  Check if there are any changes in the project('s) exports and release a new version and publish it to npm
`,
  {
    importMeta: import.meta,
    booleanDefault: undefined,
    flags: {
      build: {
        type: 'boolean',
        shortFlag: 'b'
      },
      publish: {
        type: 'boolean',
        shortFlag: 'pub'
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
      }
    }
  }
)

// console.log(cli.flags)
if (cli.flags.build) {
  time('build')
  await build()
  timeEnd('build')
}
if (cli.flags.publish) {
  time('publish')
  await publish(cli.flags.minor ? 'minor' : cli.flags.major ? 'major' : 'patch')
  timeEnd('publish')
} else {
  if (cli.flags.patch) {
    time('patch')
    await patch()
    timeEnd('patch')
  }
  if (cli.flags.minor) {
    time('minor')
    await minor()
    timeEnd('minor')
  }
  if (cli.flags.major) {
    time('major')
    await major()
    timeEnd('major')
  }
}
