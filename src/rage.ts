import { readdir, mkdir, open, stat, readFile, writeFile } from 'fs/promises'
import { join, parse } from 'path'
import { CACHE_PATH } from './constants.js'
import hashit from './hashit.js'
import { spawn } from 'child_process'
import { Listr } from 'listr2'
import semver from 'semver'

import config from './config.js'
import { checkCache, transformWorkspace } from './utils.js'
import { log } from 'console'

// console.time('build time')

type WorkspaceProject = {
  root: string
  project: string
  files: string[]
}

type ChangeResult = {
  changed: boolean
  project: string
}

type VersionType = 'patch' | 'minor' | 'major'
type ProgressTask = {
  title: string | any[]
  output: string | any[]
}

const priorityProjectsConfig = config.priority as string[]

const updateTaskProgress = (task: ProgressTask, title: string, completed: number, total: number, project: string) => {
  task.title = `${title} (${completed}/${total} done)`
  task.output = project ? `last completed: ${project}` : ''
}

const updateTaskNoop = (task: ProgressTask, title: string) => {
  task.title = `${title} (0/0 done)`
  task.output = 'no changed projects'
}

export const build = async () => {
  const build = async (root: string, project = '') =>
    new Promise<boolean>((resolve, reject) => {
      const spawnee = spawn(`npm run build`, { cwd: join(process.cwd(), root, project ?? ''), shell: true })
      const shouldLog = process.argv.includes('--log')

      let stdout = ''
      let stderr = ''

      spawnee.stdout.on('data', (data) => {
        const chunk = data.toString()
        if (shouldLog) process.stdout.write(chunk)
        else stdout += chunk
      })

      spawnee.stderr.on('data', (data) => {
        const chunk = data.toString()
        stderr += chunk
        if (shouldLog) process.stderr.write(chunk)
      })

      spawnee.on('close', (code) => {
        if (code === 0) {
          if (shouldLog && (stderr.includes('ERR') || stderr.includes('error'))) {
            console.warn(stderr)
          }
          resolve(true)
          return
        }

        reject(new Error(stderr.trim() || stdout.trim() || `npm run build failed for ${project || config.dirname}`))
      })

      spawnee.on('error', (error) => {
        reject(error)
      })
    })
  let projectDirs: WorkspaceProject[] = []

  const priorityProjects: WorkspaceProject[] = []

  const nonPriorityProjects: WorkspaceProject[] = []

  const sortProjects = () => {
    for (const project of [...projectDirs]) {
      if (priorityProjectsConfig.includes(project.project)) {
        projectDirs.slice(projectDirs.indexOf(project), 1)
        priorityProjects.push(project)
      } else {
        nonPriorityProjects.push(project)
      }
    }
  }

  const buildPriority = async (task: ProgressTask) => {
    if (priorityProjects.length === 0) return
    const results = await Promise.all(priorityProjects.map((project) => hashit(project, config.src)))
    const projectsToBuild: string[] = []

    for (const result of results) {
      if (
        result &&
        (result.changed || process.argv.includes('--all')) &&
        priorityProjectsConfig.includes(result.project)
      ) {
        projectsToBuild.push(result.project)
      }
    }

    if (projectsToBuild.length === 0) return

    for (const [index, project] of projectsToBuild.entries()) {
      await build(config.root, project)
      updateTaskProgress(task, 'building priority projects', index + 1, projectsToBuild.length, project)
    }
  }

  const createTrackedBuild = (root: string, project: string, onComplete: () => void): Promise<boolean> =>
    build(root, project).then((value) => {
      onComplete()
      return value
    })

  const buildNonPriority = async (task: ProgressTask) => {
    if (nonPriorityProjects.length === 0) return
    const results = await Promise.all(nonPriorityProjects.map((project) => hashit(project, config.src)))
    const projectsToBuild: string[] = []

    for (const result of results) {
      if (result && (result.changed || process.argv.includes('--all'))) {
        projectsToBuild.push(result.project)
      }
    }

    if (projectsToBuild.length === 0) {
      updateTaskNoop(task, 'building non priority projects')
      return
    }

    let completed = 0
    let promises: Promise<boolean>[] = []
    let count = 0
    try {
      for (const project of projectsToBuild) {
        if (count === config.availableCpuCores) {
          await Promise.all(promises)
          promises = []
          count = 0
        }

        promises.push(
          createTrackedBuild(config.root, project, () => {
            completed += 1
            updateTaskProgress(task, 'building non priority projects', completed, projectsToBuild.length, project)
          })
        )
        count += 1
      }

      if (promises.length > 0) await Promise.all(promises)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.log(message)
      if (message.includes('Missing script: "build"')) {
        console.warn(`no npm run build command present}`)
      }
      throw error
    }
  }

  // const result = await Promise.all(promises)
  // console.log(result)
  const tasks = new Listr([
    {
      title: 'Check requirements',
      task: () => checkCache()
    },
    {
      title: 'Get projects',
      task: async () => (projectDirs = await transformWorkspace(config.root, config.src))
    },
    {
      title: 'Build projects',
      task: async (_ctx, task) => {
        task.title = 'Build projects (sorting)'
        sortProjects()
        task.title = 'Build projects (priority phase)'
        await buildPriority(task)
        task.title = 'Build projects (non-priority phase)'
        await buildNonPriority(task)
      }
    }
  ])
  await tasks.run()
}

const versionTask = (project: string, type: VersionType) =>
  new Promise<boolean>((resolve) => {
    log(`bumping version for ${project !== '' ? project : config.dirname}`)
    const spawnee = spawn(`npm version ${type}`, {
      cwd: join(process.cwd(), config.root, project),
      shell: true
    })
    let stdout = ''
    spawnee.stdout.on('data', (data) => (stdout += data))
    spawnee.on('close', () => {
      const version = stdout.toString().replace('\n', '')
      console.log(`bumped version to ${version}`)
      resolve(true)
    })
    spawnee.on('error', () => resolve(true))
  })

const publishTask = (project: string, otp: string | null) =>
  new Promise<boolean>((resolve) => {
    const spawnee = spawn(`npm publish --otp=${otp}`, {
      cwd: join(process.cwd(), config.root, project ?? ''),
      shell: true
    })
    spawnee.stdout.on('data', (data) => log(data.toString()))
    spawnee.stderr.on('data', (data) => log(data.toString()))
    spawnee.on('close', () => resolve(true))
    spawnee.on('error', () => resolve(true))
  })

const versionChange = async ({ project }: Pick<WorkspaceProject, 'project'>): Promise<ChangeResult> => {
  try {
    const packageJson = (await readFile(join(config.root, project, 'package.json'))).toString()
    const version = JSON.parse(packageJson).version
    try {
      const cachedVersion = (await readFile(join(CACHE_PATH, project, 'version'))).toString()
      const changed = semver.compare(cachedVersion, version) === -1
      if (changed) {
        await writeFile(join(CACHE_PATH, project, 'version'), version)
      }
      return { changed, project }
    } catch (error) {
      await writeFile(join(CACHE_PATH, project, 'version'), version)
    }
  } catch (error) {
    return { changed: false, project }
  }
  return { changed: false, project }
}

const publishProjects = async (projects: WorkspaceProject[], otp: string | null, task: ProgressTask) => {
  const results = await Promise.all(projects.map((project) => versionChange(project)))
  const projectsToPublish: string[] = []

  for (const result of results) {
    if (result && (result.changed || process.argv.includes('--all'))) {
      projectsToPublish.push(result.project)
    }
  }

  if (projectsToPublish.length === 0) {
    updateTaskNoop(task, 'publishing projects')
    return
  }

  let completed = 0
  const promises: Promise<boolean>[] = []
  for (const project of projectsToPublish) {
    promises.push(
      publishTask(project, otp).then((value) => {
        completed += 1
        updateTaskProgress(task, 'publishing projects', completed, projectsToPublish.length, project)
        return value
      })
    )
  }

  await Promise.allSettled(promises)
}

const versionProjects = async (projects: WorkspaceProject[], type: VersionType, task: ProgressTask) => {
  const results = await Promise.all(projects.map((project) => hashit(project, config.exports)))
  const projectsToVersion: string[] = []

  for (const result of results) {
    if (result && (result.changed || process.argv.includes('--all'))) {
      projectsToVersion.push(result.project)
    }
  }

  if (projectsToVersion.length === 0) {
    updateTaskNoop(task, `${type} versions`)
    return
  }

  let completed = 0
  const promises: Promise<boolean>[] = []
  for (const project of projectsToVersion) {
    promises.push(
      versionTask(project, type).then((value) => {
        completed += 1
        updateTaskProgress(task, `${type} versions`, completed, projectsToVersion.length, project)
        return value
      })
    )
  }

  await Promise.allSettled(promises)
}

export const patch = async () => {
  let projectDirs: WorkspaceProject[] = []

  const tasks = new Listr([
    {
      title: 'Check requirements',
      task: () => checkCache()
    },
    {
      title: 'Get projects',
      task: async () =>
        (projectDirs = await transformWorkspace(config.root, [config.exports, 'package.json', 'packages.lock.json']))
    },
    {
      title: 'Version projects',
      task: async (_ctx, task) => versionProjects(projectDirs, 'patch', task)
    }
  ])
  await tasks.run()
}

export const minor = async () => {
  let projectDirs: WorkspaceProject[] = []

  const tasks = new Listr([
    {
      title: 'Check requirements',
      task: () => checkCache()
    },
    {
      title: 'Get projects',
      task: async () =>
        (projectDirs = await transformWorkspace(config.root, [config.exports, 'package.json', 'packages.lock.json']))
    },
    {
      title: 'Version projects',
      task: async (_ctx, task) => versionProjects(projectDirs, 'minor', task)
    }
  ])
  await tasks.run()
}

export const major = async () => {
  let projectDirs: WorkspaceProject[] = []

  const tasks = new Listr([
    {
      title: 'Check requirements',
      task: () => checkCache()
    },
    {
      title: 'Get projects',
      task: async () => (projectDirs = await transformWorkspace(config.root, [config.exports, config.dependencies]))
    },
    {
      title: 'Version projects',
      task: async (_ctx, task) => versionProjects(projectDirs, 'major', task)
    }
  ])
  await tasks.run()
}

// console.timeEnd('build time')
export const publish = async () => {
  let projectDirs: WorkspaceProject[] = []

  const otpIndex = process.argv.indexOf('--otp')
  const otp = otpIndex > -1 ? (process.argv[otpIndex + 1] ?? null) : null

  const tasks = new Listr([
    {
      title: 'Check requirements',
      task: () => checkCache()
    },
    {
      title: 'Get projects',
      task: async () =>
        (projectDirs = await transformWorkspace(config.root, [config.exports, 'package.json', 'packages.lock.json']))
    },
    {
      title: 'Publish projects',
      task: async (_ctx, task) => publishProjects(projectDirs, otp, task)
    }
  ])
  await tasks.run()
}
