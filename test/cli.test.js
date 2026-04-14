import test from 'node:test'
import assert from 'node:assert/strict'

import { createCli, resolveAction } from '../exports/cli-lib.js'

const importMeta = import.meta

test('createCli parses command input and shared options', () => {
  const cli = createCli(importMeta, ['publish', '--otp', '123456', '--log'])

  assert.deepEqual(cli.input, ['publish'])
  assert.equal(cli.flags.publish, undefined)
  assert.equal(cli.flags.otp, '123456')
  assert.equal(cli.flags.log, true)
})

test('resolveAction returns a command action', () => {
  assert.deepEqual(resolveAction(['build'], {}), { action: 'build' })
})

test('resolveAction returns an action selected by flag', () => {
  assert.deepEqual(resolveAction([], { patch: true }), { action: 'patch' })
})

test('resolveAction rejects multiple action flags', () => {
  assert.deepEqual(resolveAction([], { build: true, patch: true }), {
    error: 'Choose a single action flag: --build, --patch',
    showHelp: true
  })
})

test('resolveAction rejects an unknown command', () => {
  assert.deepEqual(resolveAction(['shipit'], {}), {
    error: 'Unknown command: shipit',
    showHelp: true
  })
})

test('resolveAction rejects mixing a command and action flag', () => {
  assert.deepEqual(resolveAction(['build'], { patch: true }), {
    error: 'Use either a command or an action flag, not both',
    showHelp: true
  })
})

test('resolveAction rejects missing actions', () => {
  assert.deepEqual(resolveAction([], {}), {
    error: 'No action provided',
    showHelp: true
  })
})
