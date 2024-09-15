import { readdir } from 'fs/promises'
import { availableParallelism } from 'os'
import { join } from 'path'

export const CACHE_PATH = join(process.cwd(), '.builder-cache')

const files = await readdir(process.cwd())

const isPossibleMonoRepo = files.includes('packages')

export const DEFAULT_CONFIG = {
  priority: [],
  root: isPossibleMonoRepo ? 'packages' : './',
  src: 'src',
  exports: 'exports',
  dependencies: 'package.lock.json',
  availableCpuCores: availableParallelism()
}
