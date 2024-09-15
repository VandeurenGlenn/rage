import json from '@rollup/plugin-json'
import typescript from '@rollup/plugin-typescript'
import nodeResolve from '@rollup/plugin-node-resolve'
import modify from 'rollup-plugin-modify'

import { readdir, unlink } from 'fs/promises'
import { join } from 'path'
import commonjs from '@rollup/plugin-commonjs'

try {
  const dir = await readdir('./exports', { recursive: true })
  const promises = []

  for (const path of dir) {
    promises.push(unlink(join('./exports', path)))
  }

  await Promise.allSettled(promises)
} catch (error) {}

export default [
  {
    input: ['./src/machine-worker.ts', './src/block-worker.js'],
    output: {
      dir: './exports',
      format: 'es'
    },
    plugins: [
      json(),
      typescript(),
      nodeResolve({
        mainFields: ['module', 'browser']
      }),
      commonjs(),
      modify({
        '@leofcoin/workers/block-worker.js': 'block-worker.js'
      })
    ]
  },

  {
    input: ['./src/machine-worker.ts', './src/block-worker.js'],
    output: {
      dir: './exports/browser',
      format: 'es'
    },
    plugins: [
      json(),
      typescript({ outDir: './exports/browser', declaration: false }),
      nodeResolve({
        mainFields: ['module', 'browser']
      }),
      commonjs(),
      modify({
        '@leofcoin/workers/block-worker.js': './block-worker.js'
      })
    ]
  }
]
