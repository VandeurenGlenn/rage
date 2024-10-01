import { readdir, glob, stat, mkdir, open } from 'fs/promises'
import { join, parse } from 'path'
import { CACHE_PATH } from './constants.js'
import config from './config.js'

const globIt = async (targets) => {
  const files = []

  const _files = glob(targets)
  for await (const file of _files) {
    const stats = await stat(file)
    if (stats.isFile()) files.push(file)
  }
  return files
}

export const transformWorkspace = async (root, target) => {
  if (!Array.isArray(target)) target = [target]
  if (config.monorepo) {
    return Promise.all(
      (await readdir(root)).map(async (project) => {
        const targets = []
        let files = []
        for (const _target of target) {
          const parsed = parse(_target)
          if (parsed.ext) {
            targets.push(`${root}/${project}/${_target}`)
          } else {
            targets.push(`${root}/${project}/${_target}/**`)
          }
        }
        try {
          files = await globIt(targets)
        } catch (error) {
          console.warn(`nothing found for, ${join(root, project, target)}`)
        }
        return { root, project, files }
      })
    )
  } else {
    const targets = []
    let files = []
    for (const _target of target) {
      const parsed = parse(_target)
      if (parsed.ext) {
        targets.push(`${root}/${_target}`)
      } else {
        targets.push(`${root}/${_target}/**`)
      }
    }
    try {
      files = await globIt(targets)
    } catch (error) {
      console.warn(`nothing found for, ${join(root, target)}`)
    }
    return [{ root, project: '', files }]
  }
}

export const checkCache = async () => {
  try {
    const fd = await open(CACHE_PATH)
    await fd.close()
  } catch (error) {
    await mkdir(CACHE_PATH, { recursive: true })
  }
}
