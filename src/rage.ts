import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { CACHE_PATH } from './constants.js'
import hashit from './hashit.js'
import { spawn } from 'child_process'
import { Listr } from 'listr2'
import semver from 'semver'

import config from './config.js'
import { checkCache, transformWorkspace } from './utils.js'
import { log } from 'console'
import { buildWorkspace } from './workspace-build.js'

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

const DEFAULT_JOB_TIMEOUT_MS = 10 * 60 * 1000

const hasErrorSignal = (value: string) => /(error|err|failed|fatal|exception)/i.test(value)

const logStderrSignal = (scope: string, project: string, value: string) => {
  if (!hasErrorSignal(value)) return
  const label = project || config.dirname
  console.warn(`[${scope}] stderr signal for ${label}: ${value.trim()}`)
}

const updateTaskProgress = (task: ProgressTask, title: string, completed: number, total: number, project: string) => {
  task.title = `${title} (${completed}/${total} done)`
  task.output = project ? `last completed: ${project}` : ''
}

const updateTaskNoop = (task: ProgressTask, title: string) => {
  task.title = `${title} (0/0 done)`
  task.output = 'no changed projects'
}

export const build = async (options: { jobs?: number; dryRun?: boolean } = {}) => {
  const plan = await buildWorkspace({
    legacyRoot: config.monorepo ? config.root : undefined,
    priority: config.priority,
    outputDirectory: config.exports,
    all: process.argv.includes('--all') || process.argv.includes('-a'),
    log: process.argv.includes('--log') || process.argv.includes('-l'),
    ...options
  })
  if (options.dryRun) {
    for (const project of plan) {
      console.log(`${project.build ? 'BUILD' : 'SKIP'} ${project.name} (${project.reason})${project.dependencies.length ? ' after ' + project.dependencies.join(', ') : ''}`)
    }
  }
}

const versionTask = (project: string, type: VersionType) =>
  new Promise<boolean>((resolve, reject) => {
    log(`bumping version for ${project !== '' ? project : config.dirname}`)
    const timeoutMs = Number(process.env.RAGE_JOB_TIMEOUT_MS ?? DEFAULT_JOB_TIMEOUT_MS)
    const spawnee = spawn(`npm version ${type}`, {
      cwd: join(process.cwd(), config.root, project),
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stderr = ''
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      console.error(`version ${type} timed out after ${timeoutMs}ms for ${project || config.dirname}`)
      spawnee.kill('SIGTERM')
    }, timeoutMs)

    spawnee.stdin.on('error', (error: Error) => {
      console.error(`version stdin stream error for ${project || config.dirname}: ${error.message}`)
    })
    spawnee.stdin.end()

    let stdout = ''
    spawnee.stdout.on('data', (data) => (stdout += data))

    spawnee.stderr.on('data', (data) => {
      const chunk = data.toString()
      stderr += chunk
      logStderrSignal('version', project, chunk)
    })

    spawnee.on('close', (code) => {
      clearTimeout(timeout)

      if (timedOut) {
        reject(new Error(`version ${type} timed out after ${timeoutMs}ms for ${project || config.dirname}`))
        return
      }

      const version = stdout.toString().replace('\n', '')
      if (code === 0) {
        if (stderr.trim()) logStderrSignal('version', project, stderr)
        console.log(`bumped version to ${version}`)
        resolve(true)
        return
      }

      reject(new Error(stderr.trim() || `npm version ${type} failed for ${project || config.dirname}`))
    })

    spawnee.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })

const publishTask = (project: string, otp: string | null) =>
  new Promise<boolean>((resolve, reject) => {
    const timeoutMs = Number(process.env.RAGE_JOB_TIMEOUT_MS ?? DEFAULT_JOB_TIMEOUT_MS)
    const spawnee = spawn(`npm publish --otp=${otp}`, {
      cwd: join(process.cwd(), config.root, project ?? ''),
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stderr = ''
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      console.error(`publish timed out after ${timeoutMs}ms for ${project || config.dirname}`)
      spawnee.kill('SIGTERM')
    }, timeoutMs)

    spawnee.stdin.on('error', (error: Error) => {
      console.error(`publish stdin stream error for ${project || config.dirname}: ${error.message}`)
    })
    spawnee.stdin.end()

    spawnee.stdout.on('data', (data) => log(data.toString()))
    spawnee.stderr.on('data', (data) => {
      const chunk = data.toString()
      stderr += chunk
      log(data.toString())
      logStderrSignal('publish', project, chunk)
    })
    spawnee.on('close', (code) => {
      clearTimeout(timeout)

      if (timedOut) {
        reject(new Error(`publish timed out after ${timeoutMs}ms for ${project || config.dirname}`))
        return
      }

      if (code === 0) {
        if (stderr.trim()) logStderrSignal('publish', project, stderr)
        resolve(true)
        return
      }

      reject(new Error(stderr.trim() || `npm publish failed for ${project || config.dirname}`))
    })
    spawnee.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
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
