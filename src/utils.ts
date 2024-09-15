import { readdir, glob, stat, mkdir, open } from 'fs/promises'
import { join, parse } from 'path'
import { CACHE_PATH } from './constants.js'

export const transformWorkspaceDir = async (root, target) =>
  Promise.all(
    (await readdir(root)).map(async (project) => {
      if (!Array.isArray(target)) target = [target]
      let targets = []
      for (const _target of target) {
        const parsed = parse(_target)
        if (parsed.ext) {
          targets.push(`${root}/${project}/${_target}`)
        } else {
          targets.push(`${root}/${project}/${_target}/**`)
        }
      }
      let files = []
      try {
        const _files = await glob(targets)
        for await (const file of _files) {
          const stats = await stat(file)
          if (stats.isFile()) files.push(file)
        }
      } catch (error) {
        console.warn(`nothing found for, ${join(root, project, target)}`)
      }
      console.log(project)

      return { root, project, files }
    })
  )

export const checkCache = async () => {
  try {
    const fd = await open(CACHE_PATH)
    await fd.close()
  } catch (error) {
    await mkdir(CACHE_PATH, { recursive: true })
  }
}
