import { readdir, mkdir, open, stat, readFile, writeFile } from 'fs/promises'
import { join, parse } from 'path'
import { CACHE_PATH } from './constants.js'
import hashit from './hashit.js'
import { spawn } from 'child_process'
import Listr from 'listr'
import semver from 'semver'

import config from './config.js'
import { checkCache, transformWorkspace } from './utils.js'
import { log } from 'console'

// console.time('build time')

export const build = async () => {
  const build = async (root, project) =>
    new Promise((resolve) => {
      const spawnee = spawn(`npm run build`, { cwd: join(process.cwd(), root, project ?? ''), shell: true })

      let stderr = ''

      if (process.argv.includes('--log')) {
        spawnee.stderr.on('data', (data) => {
          stderr += data.toString()
        })
      }

      spawnee.on('close', () => {
        if (process.argv.includes('--log') && (stderr.includes('ERR') || stderr.includes('error'))) {
          console.warn(stderr)
        }
        resolve(true)
      })

      spawnee.on('error', () => resolve(true))
    })
  let projectDirs

  const priorityProjects = []

  const nonPriorityProjects = []

  const sortProjects = () => {
    for (const project of [...projectDirs]) {
      if (config.priority.includes(project.project)) {
        projectDirs.slice(projectDirs.indexOf(project), 1)
        priorityProjects.push(project)
      } else {
        nonPriorityProjects.push(project)
      }
    }
  }

  const buildPriority = async () => {
    if (priorityProjects.length === 0) return
    const results = await Promise.all(priorityProjects.map((project) => hashit(project, config.src)))
    for (const result of results) {
      if (result) {
        if (result.changed || process.argv.includes('--all'))
          if (config.priority.includes(result.project)) await build(config.root, result.project)
      }
    }
  }

  const buildNonPriority = async () => {
    if (nonPriorityProjects.length === 0) return
    const results = await Promise.all(nonPriorityProjects.map((project) => hashit(project, config.src)))
    let promises = []
    let count = 0
    try {
      for (const result of results) {
        if (result) {
          if (result.changed || process.argv.includes('--all')) {
            if (count === config.availableCpuCores) {
              await Promise.all(promises)
              promises = []
              count = 0
            }
            promises.push(build(config.root, result.project))
            count += 1
          }
        }
      }

      if (promises.length > 0) await Promise.all(promises)
    } catch (error) {
      console.log(error.message)
      if (error.message.includes('Missing script: "build"')) {
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
      task: () =>
        new Listr([
          {
            title: 'cache',
            task: () => checkCache()
          }
        ])
    },
    {
      title: 'Get projects',
      task: () =>
        new Listr([
          {
            title: 'getting projects',
            task: async () => (projectDirs = await transformWorkspace(config.root, config.src))
          }
        ])
    },
    {
      title: 'Build projects',
      task: () =>
        new Listr([
          { title: 'sorting projects', task: () => sortProjects() },
          { title: 'building priority projects', task: () => buildPriority() },
          {
            title: 'building non priority projects',
            task: () => buildNonPriority()
          }
        ])
    }
  ])
  await tasks.run()
}

const versionTask = (project, type) =>
  new Promise((resolve) => {
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

const publishTask = (project, otp) =>
  new Promise((resolve) => {
    const spawnee = spawn(`npm publish --otp=${otp}`, {
      cwd: join(process.cwd(), config.root, project ?? ''),
      shell: true
    })
    spawnee.stdout.on('data', (data) => log(data.toString()))
    spawnee.stderr.on('data', (data) => log(data.toString()))
    spawnee.on('close', () => resolve(true))
    spawnee.on('error', () => resolve(true))
  })

const versionChange = async ({ project }) => {
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

const publishProjects = async (projects, otp) => {
  const results = await Promise.all(projects.map((project) => versionChange(project)))

  const promises = []
  for (const result of results) {
    if (result) {
      if (result.changed || process.argv.includes('--all')) promises.push(publishTask(result.project, otp))
    }
  }
  await Promise.allSettled(promises)
}

const versionProjects = async (projects, type) => {
  const results = await Promise.all(projects.map((project) => hashit(project, config.exports)))
  const promises = []
  for (const result of results) {
    if (result) {
      if (result.changed || process.argv.includes('--all')) promises.push(versionTask(result.project, type))
    }
  }
  await Promise.allSettled(promises)
}

export const patch = async () => {
  let projectDirs

  const tasks = new Listr([
    {
      title: 'Check requirements',
      task: () =>
        new Listr([
          {
            title: 'cache',
            task: () => checkCache()
          }
        ])
    },
    {
      title: 'Get projects',
      task: () =>
        new Listr([
          {
            title: 'getting projects',
            task: async () =>
              (projectDirs = await transformWorkspace(config.root, [
                config.exports,
                'package.json',
                'packages.lock.json'
              ]))
          }
        ])
    },
    {
      title: 'Version projects',
      task: async () => versionProjects(projectDirs, 'patch')
    }
  ])
  await tasks.run()
}

export const minor = async () => {
  let projectDirs

  const tasks = new Listr([
    {
      title: 'Check requirements',
      task: () =>
        new Listr([
          {
            title: 'cache',
            task: () => checkCache()
          }
        ])
    },
    {
      title: 'Get projects',
      task: () =>
        new Listr([
          {
            title: 'getting projects',
            task: async () =>
              (projectDirs = await transformWorkspace(config.root, [
                config.exports,
                'package.json',
                'packages.lock.json'
              ]))
          }
        ])
    },
    {
      title: 'Version projects',
      task: async () => versionProjects(projectDirs, 'minor')
    }
  ])
  await tasks.run()
}

export const major = async () => {
  let projectDirs

  const tasks = new Listr([
    {
      title: 'Check requirements',
      task: () =>
        new Listr([
          {
            title: 'cache',
            task: () => checkCache()
          }
        ])
    },
    {
      title: 'Get projects',
      task: () =>
        new Listr([
          {
            title: 'getting projects',
            task: async () =>
              (projectDirs = await transformWorkspace(config.root, [config.exports, config.dependencies]))
          }
        ])
    },
    {
      title: 'Version projects',
      task: async () => versionProjects(projectDirs, 'major')
    }
  ])
  await tasks.run()
}

// console.timeEnd('build time')
export const publish = async () => {
  let projectDirs

  const tasks = new Listr([
    {
      title: 'Check requirements',
      task: () =>
        new Listr([
          {
            title: 'cache',
            task: () => checkCache()
          }
        ])
    },
    {
      title: 'Get projects',
      task: () =>
        new Listr([
          {
            title: 'getting projects',
            task: async () =>
              (projectDirs = await transformWorkspace(config.root, [
                config.exports,
                'package.json',
                'packages.lock.json'
              ]))
          }
        ])
    },
    {
      title: 'Publish projects',
      task: async () =>
        publishProjects(
          projectDirs,
          process.argv.indexOf('--otp') > -1 ? process.argv[process.argv.indexOf('--otp') + 1] : null
        )
    }
  ])
  await tasks.run()
}
