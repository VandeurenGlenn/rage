import { mkdir, writeFile, readFile } from 'fs/promises'
import { createHash } from 'crypto'
import { join } from 'path'
import { CACHE_PATH } from './constants.js'

type HashProject = {
  project: string
  files: string[]
}

type HashResult = {
  changed: boolean
  hash: string
  project: string
}

const readAndCache = async (file: string): Promise<string> => {
  try {
    const content = await readFile(file)
    const hash = createHash('SHA1')
    hash.update(content)
    return hash.digest('hex')
  } catch (error) {
    console.error(error)
    return ''
  }
}

const _createHash = (input: string): string => {
  const hash = createHash('SHA1')
  hash.update(input)
  return hash.digest('hex')
}

export default async ({ project, files }: HashProject, _target: string): Promise<HashResult | undefined> => {
  let changed = false
  let originalHash: string | undefined
  let hash: string
  const hashes: string[] = []
  const concurrency = 100

  for (let i = 0; i < files.length; i += concurrency) {
    const chunk = files.slice(i, i + concurrency)
    const chunkHashes = await Promise.all(chunk.map((file) => readAndCache(file)))
    hashes.push(...chunkHashes)
  }

  if (hashes.length === 0) return

  const PROJECT_CACHE_PATH = join(CACHE_PATH, project ?? '')

  try {
    originalHash = (await readFile(join(PROJECT_CACHE_PATH, 'hash'))).toString()
  } catch (error) {
    await mkdir(PROJECT_CACHE_PATH, { recursive: true })
  }

  hash = _createHash(hashes.join())

  if (String(originalHash) !== String(hash)) {
    changed = true
    await writeFile(join(PROJECT_CACHE_PATH, 'hash'), hash)
  }
  return { changed, hash, project }
}
