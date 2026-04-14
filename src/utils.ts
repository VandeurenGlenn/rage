import { readdir, glob, stat, mkdir, open } from 'fs/promises'
import { join, parse } from 'path'
import { CACHE_PATH } from './constants.js'
import config from './config.js'

type WorkspaceProject = {
  root: string
  project: string
  files: string[]
}

const globIt = async (targets: string[]): Promise<string[]> => {
  const files: string[] = []
  const _files = glob(targets)
  const promises: Promise<string | null>[] = []
  for await (const file of _files) {
    promises.push(stat(file).then((stats) => (stats.isFile() ? file : null)))
  }
  const results = await Promise.all(promises)
  return results.filter((file) => file !== null)
}

export const transformWorkspace = async (root: string, target: string | string[]): Promise<WorkspaceProject[]> => {
  const targetsToMatch = Array.isArray(target) ? target : [target]

  if (config.monorepo) {
    return Promise.all(
      (await readdir(root)).map(async (project) => {
        const targets: string[] = []
        let files: string[] = []
        for (const _target of targetsToMatch) {
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
          console.warn(`nothing found for, ${join(root, project, targetsToMatch.join(','))}`)
        }
        return { root, project, files }
      })
    )
  } else {
    const targets: string[] = []
    let files: string[] = []
    for (const _target of targetsToMatch) {
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
      console.warn(`nothing found for, ${join(root, targetsToMatch.join(','))}`)
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
