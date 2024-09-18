import { createReadStream, createWriteStream } from 'fs'
import { mkdir, writeFile, readFile, FileHandle } from 'fs/promises'
import { createHash } from 'crypto'
import { Writable, Readable, ReadableOptions } from 'stream'

import { join } from 'path'
import { CACHE_PATH } from './constants.js'

class CacheStream extends Writable {
  resolver
  constructor(resolver) {
    super()
    this.resolver = resolver
  }
  _write(chunk, encoding, callback) {
    this.resolver(chunk)

    // fs.write(this.fd, chunk, callback)
  }
}

const readAndCache = (file) =>
  new Promise((resolve) => {
    const hash = createHash('SHA1')
    try {
      const input = createReadStream(file)
      input.pipe(hash).setEncoding('hex').pipe(new CacheStream(resolve))
    } catch (error) {
      console.error(error)
    }
  })

class HashStream extends Readable {
  hashes: string[]
  constructor(hashes: string[], opt?: ReadableOptions) {
    super(opt)
    this.hashes = hashes
  }

  _read() {
    this.push(this.hashes)
    this.push(null)
  }
}

const _createHash = (input) =>
  new Promise((resolve) => {
    const hash = createHash('SHA1')
    new HashStream(input).pipe(hash).setEncoding('hex').pipe(new CacheStream(resolve))
  })

export default async ({ project, files }, target) => {
  let changed = false
  let originalHash
  let hash
  let promises = []

  for (const file of files) {
    promises.push(readAndCache(file))
  }

  if (promises.length === 0) return

  const PROJECT_CACHE_PATH = join(CACHE_PATH, project ?? '', target)

  try {
    originalHash = (await readFile(PROJECT_CACHE_PATH)).toString()
  } catch (error) {
    await mkdir(join(CACHE_PATH, project ?? ''), { recursive: true })
  }

  promises = await Promise.all(promises)
  hash = await _createHash(promises.join())

  if (String(originalHash) !== String(hash.toString())) {
    changed = true
    await writeFile(PROJECT_CACHE_PATH, hash)
  }
  return { changed, hash: hash.toString(), project }
}
