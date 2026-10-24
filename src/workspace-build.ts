import { createHash, randomUUID } from 'node:crypto'
import { glob, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import semver from 'semver'

type Manifest = {
  name?: string
  version?: string
  workspaces?: string[] | { packages: string[] }
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  [field: string]: unknown
}
export type BuildProject = { name: string; directory: string; path: string; workspace: boolean; manifest: Manifest; dependencies: string[] }
export type BuildOptions = {
  cwd?: string
  legacyRoot?: string
  priority?: string[]
  outputDirectory?: string
  jobs?: number
  all?: boolean
  log?: boolean
  dryRun?: boolean
  timeoutMs?: number
}
type CacheEntry = { hash: string; outputs: string[] }
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'))
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const inside = (root: string, target: string) => {
  const path = relative(root, target)
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)
}

/** npm workspace declarations are authoritative; never build the root wrapper. */
export const discoverBuildProjects = async (cwd: string, legacyRoot?: string): Promise<BuildProject[]> => {
  const root = await realpath(cwd)
  const manifest: Manifest = await json(join(root, 'package.json'))
  const workspaceMode = manifest.workspaces !== undefined
  const directories = new Set<string>()
  if (manifest.workspaces !== undefined) {
    const patterns = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages
    if (!Array.isArray(patterns) || patterns.some(pattern => typeof pattern !== 'string')) {
      throw new Error('package.json workspaces must be an array of patterns or { packages: [...] }')
    }
    // Apply exclusions after includes regardless of their position in the array.
    for (const negative of [false, true]) {
      for (const pattern of patterns.filter(pattern => pattern.startsWith('!') === negative)) {
        const target = negative ? pattern.slice(1) : pattern
        if (isAbsolute(target) || !inside(root, resolve(root, target))) throw new Error(`workspace escapes root: ${target}`)
        for await (const path of glob(`${target.replace(/\/$/, '')}/package.json`, {
          cwd: root, exclude: ['**/node_modules/**', '**/.git/**']
        })) {
          const directory = await realpath(dirname(resolve(root, path)))
          if (!inside(root, directory)) throw new Error(`workspace symlink escapes root: ${path}`)
          if (directory === root) continue
          if (negative) directories.delete(directory)
          else directories.add(directory)
        }
      }
    }
  } else if (legacyRoot && resolve(root, legacyRoot) !== root) {
    const directory = resolve(root, legacyRoot)
    if (!inside(root, directory)) throw new Error('legacy build root escapes project')
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(directory, entry.name)
      try { await readFile(join(path, 'package.json')); directories.add(path) } catch (error) { if (!missing(error)) throw error }
    }
  } else {
    directories.add(root)
  }
  const projects: BuildProject[] = []
  const names = new Set<string>()
  for (const directory of [...directories].sort()) {
    const manifest: Manifest = await json(join(directory, 'package.json'))
    const path = relative(root, directory) || '.'
    const name = manifest.name ?? path
    if (names.has(name)) throw new Error(`duplicate workspace name: ${name}`)
    names.add(name)
    projects.push({ name, path, directory, workspace: workspaceMode && directory !== root, manifest, dependencies: [] })
  }
  const byName = new Map(projects.map(project => [project.name, project]))
  for (const project of projects) {
    const dependencies = new Set<string>()
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const) {
      for (const [name, range] of Object.entries(project.manifest[section] ?? {})) {
        const dependency = byName.get(name)
        if (!dependency) continue
        let local = false
        if (/^(file:|link:)/.test(range)) local = resolve(project.directory, range.replace(/^(file:|link:)/, '')) === dependency.directory
        else {
          const versionRange = range.startsWith('workspace:') ? range.slice(10) : range
          local = Boolean(dependency.manifest.version && (
            (range.startsWith('workspace:') && ['*', '^', '~'].includes(versionRange)) ||
            semver.satisfies(dependency.manifest.version, versionRange)
          ))
        }
        if (local) dependencies.add(name)
      }
    }
    project.dependencies = [...dependencies].sort()
  }
  return projects
}

const sortedProjects = (projects: BuildProject[], priority: string[]) => {
  const rank = (project: BuildProject) => {
    const index = priority.findIndex(name => [project.name, project.path, project.path.split(sep).at(-1)].includes(name))
    return index < 0 ? priority.length : index
  }
  const byName = new Map(projects.map(project => [project.name, project]))
  const ordered: BuildProject[] = []
  const visiting: string[] = []
  const visited = new Set<string>()
  const visit = (project: BuildProject) => {
    if (visiting.includes(project.name)) throw new Error(`workspace dependency cycle: ${[...visiting, project.name].join(' -> ')}`)
    if (visited.has(project.name)) return
    visiting.push(project.name)
    for (const name of project.dependencies) visit(byName.get(name)!)
    visiting.pop()
    visited.add(project.name)
    ordered.push(project)
  }
  for (const project of [...projects].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path))) visit(project)
  return ordered
}

const inputFiles = async (directory: string, ignored: Set<string>, prefix = ''): Promise<[string, string][]> => {
  const entries: [string, string][] = []
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (['node_modules', '.git', '.builder-cache', '.DS_Store'].includes(entry.name) || (!prefix && ignored.has(entry.name))) continue
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    const path = join(directory, entry.name)
    if (entry.isDirectory()) entries.push(...await inputFiles(path, ignored, name))
    else if (entry.isFile()) entries.push([name, hash(await readFile(path))])
    // Arbitrary linked build inputs cannot be safely fingerprinted without
    // traversing external trees. Invalidate rather than risk a false cache hit.
    else if (entry.isSymbolicLink()) entries.push([name, `linked-input:${randomUUID()}`])
  }
  return entries
}

const outputPaths = async (project: BuildProject, ignored: Set<string>) => {
  const paths = new Set<string>()
  const visit = (value: unknown) => {
    if (typeof value === 'string' && !value.includes('*')) {
      const path = resolve(project.directory, value)
      if (inside(project.directory, path) && !value.replace(/^\.\//, '').startsWith('src/')) paths.add(path)
    } else if (value && typeof value === 'object') for (const child of Object.values(value)) visit(child)
  }
  for (const field of ['main', 'module', 'types', 'typings', 'exports', 'bin']) visit(project.manifest[field])
  const collect = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await collect(path)
      else if (entry.isFile()) paths.add(path)
    }
  }
  for (const output of ignored) {
    try { await collect(join(project.directory, output)) } catch (error) { if (!missing(error)) throw error }
  }
  // Only actual successful-build outputs are known artifacts. Old/unused
  // manifest entries must not cause a permanent rebuild loop. Once recorded,
  // deletion of any of these artifacts invalidates the next cache lookup.
  const existing: string[] = []
  for (const path of paths) {
    try { await stat(path); existing.push(relative(project.directory, path)) }
    catch (error) { if (!missing(error)) throw error }
  }
  return existing.sort()
}

const runBuild = (project: BuildProject, root: string, log: boolean, timeoutMs: number) => new Promise<void>((resolve, reject) => {
  let stack: string[]
  try { stack = JSON.parse(process.env.RAGE_INTERNAL_BUILD_STACK ?? '[]') }
  catch { reject(new Error('invalid Rage build recursion context')); return }
  if (!Array.isArray(stack) || stack.includes(project.directory)) {
    reject(new Error(`recursive build invocation: ${project.name}; declare workspaces to avoid recursion`))
    return
  }
  const windows = process.platform === 'win32'
  if (windows && project.workspace && /[&|<>^%"\s()]/.test(project.name)) {
    reject(new Error(`unsafe npm workspace name: ${project.name}`))
    return
  }
  const args = project.workspace
    ? ['run', 'build', '--workspace', project.name, '--include-workspace-root=false']
    : ['run', 'build', '--workspaces=false']
  // npm.cmd needs cmd.exe on Windows. Pass one validated command explicitly,
  // not the deprecated shell:true + args combination (DEP0190).
  const executable = windows ? process.env.ComSpec ?? 'cmd.exe' : 'npm'
  const commandArgs = windows ? ['/d', '/s', '/v:off', '/c', `npm.cmd ${args.join(' ')}`] : args
  const child = spawn(executable, commandArgs, {
    cwd: project.workspace ? root : project.directory, shell: false, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, RAGE_INTERNAL_BUILD_STACK: JSON.stringify([...stack, project.directory]) }
  })
  let output = ''
  let timedOut = false
  let escalation: ReturnType<typeof setTimeout> | undefined
  const terminate = (signal: NodeJS.Signals) => {
    try {
      if (windows) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => child.kill())
      else if (child.pid) process.kill(-child.pid, signal)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal) }
  }
  const timeout = setTimeout(() => {
    timedOut = true
    terminate('SIGTERM')
    escalation = setTimeout(() => terminate('SIGKILL'), 500)
  }, timeoutMs)
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-65_536); if (log) process.stdout.write(chunk) })
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-65_536); if (log) process.stderr.write(chunk) })
  const clear = () => { clearTimeout(timeout); clearTimeout(escalation) }
  child.once('error', error => { clear(); reject(error) })
  child.once('close', (code, signal) => {
    clear()
    if (timedOut) reject(new Error(`build timed out after ${timeoutMs}ms: ${project.name}`))
    else if (code !== 0) reject(new Error(`build failed: ${project.name} (${signal ?? code})\n${output.trim()}`))
    else resolve()
  })
})

export const buildWorkspace = async (options: BuildOptions = {}) => {
  const cwd = await realpath(options.cwd ?? process.cwd())
  const jobs = options.jobs ?? availableParallelism()
  const timeoutMs = options.timeoutMs ?? Number(process.env.RAGE_BUILD_TIMEOUT_MS ?? 600_000)
  if (!Number.isSafeInteger(jobs) || jobs < 1) throw new Error('build jobs must be a positive integer')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('build timeout must be a positive integer')
  const projects = sortedProjects(await discoverBuildProjects(cwd, options.legacyRoot), options.priority ?? [])
  if (projects.length === 1 && projects[0].directory === cwd && /(?:^|[;&|])\s*(?:npx\s+)?rage\s+(?:build\b|--build\b|-b\b)/.test(projects[0].manifest.scripts?.build ?? '')) {
    throw new Error('root build invokes rage itself; declare workspaces or configure a separate root to avoid recursion')
  }
  const ignored = new Set(['exports', 'dist', 'www', 'coverage', options.outputDirectory ?? 'exports'])
  for (const directory of ignored) {
    if (!directory || directory === '.' || directory.includes('/') || directory.includes('\\')) throw new Error('build outputDirectory must be a direct child directory')
  }
  const cachePath = join(cwd, '.builder-cache', 'build-v2.json')
  let cache: Record<string, CacheEntry> = {}
  try {
    const data = await json(cachePath)
    if (data.version === 2 && data.projects && typeof data.projects === 'object') cache = data.projects
  } catch (error) { if (!missing(error) && !(error instanceof SyntaxError)) throw error }
  const shared: [string, string][] = [['runtime', `${process.version}:${process.platform}:${process.arch}`]]
  const tool = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  shared.push(['rage', tool.version])
  shared.push(['builder', hash(await readFile(new URL('./workspace-build.js', import.meta.url)))])
  // Lock/config/build-graph changes take the full correctness path. No cache
  // writes occur until the associated build succeeds.
  if (!projects.some(project => project.directory === cwd)) {
    for (const entry of await readdir(cwd, { withFileTypes: true })) {
      if (entry.isFile() && (/\.(json|lock|lockb|ya?ml|[cm]?js|ts|sh|html|css)$/.test(entry.name) || entry.name.startsWith('rage.') || ['.npmrc', '.nvmrc', '.node-version', '.browserslistrc', '.babelrc'].includes(entry.name))) {
        shared.push([entry.name, hash(await readFile(join(cwd, entry.name)))])
      }
    }
    for (const directory of ['scripts', 'builder', 'tools']) {
      try { shared.push(...(await inputFiles(join(cwd, directory), ignored)).map(([path, digest]) => [`${directory}/${path}`, digest] as [string, string])) }
      catch (error) { if (!missing(error)) throw error }
    }
  }
  const commonHash = hash(JSON.stringify(shared.sort(([a], [b]) => a.localeCompare(b))))
  const hashes = new Map<string, string>()
  const shouldBuild = new Map<string, boolean>()
  const reasons = new Map<string, string>()
  for (const project of projects) {
    const digest = hash(JSON.stringify([commonHash, await inputFiles(project.directory, ignored), project.dependencies.map(name => [name, hashes.get(name)])]))
    hashes.set(project.name, digest)
    const entry = cache[project.path]
    let outputsPresent = true
    for (const path of entry?.outputs ?? []) {
      if (typeof path !== 'string' || !inside(project.directory, resolve(project.directory, path))) { outputsPresent = false; break }
      try { await stat(resolve(project.directory, path)) } catch (error) { if (missing(error)) { outputsPresent = false; break } throw error }
    }
    const hasScript = typeof project.manifest.scripts?.build === 'string' && project.manifest.scripts.build.trim().length > 0
    const changed = options.all || !entry || entry.hash !== digest || !Array.isArray(entry.outputs) || !outputsPresent
    shouldBuild.set(project.name, Boolean(hasScript && changed))
    reasons.set(project.name, !hasScript ? 'no build script' : !changed ? 'cached' : !outputsPresent ? 'missing output' : options.all ? '--all' : 'changed inputs/dependencies')
  }
  const plan = projects.map(project => ({ name: project.name, path: project.path, dependencies: project.dependencies, build: shouldBuild.get(project.name)!, reason: reasons.get(project.name)! }))
  if (options.dryRun) return plan
  let writes = Promise.resolve()
  const persist = () => {
    writes = writes.then(async () => {
      await mkdir(dirname(cachePath), { recursive: true })
      const temporary = `${cachePath}.${process.pid}.tmp`
      await writeFile(temporary, JSON.stringify({ version: 2, projects: cache }, null, 2))
      await rename(temporary, cachePath)
    })
    return writes
  }
  const pending = new Set(projects.map(project => project.name))
  const done = new Set<string>()
  const running = new Map<string, Promise<{ name: string; error?: unknown }>>()
  while (pending.size || running.size) {
    for (const project of projects) {
      if (running.size >= jobs) break
      if (!pending.has(project.name) || project.dependencies.some(name => !done.has(name))) continue
      pending.delete(project.name)
      running.set(project.name, (async () => {
        if (shouldBuild.get(project.name)) {
          console.log(`BUILD ${project.name} (${reasons.get(project.name)})`)
          // A forced rebuild can damage previously valid outputs even when its
          // inputs have not changed. Revoke that old success before launching.
          delete cache[project.path]
          await persist()
          await runBuild(project, cwd, Boolean(options.log), timeoutMs)
          cache[project.path] = { hash: hashes.get(project.name)!, outputs: await outputPaths(project, ignored) }
          await persist()
        } else console.log(`SKIP ${project.name} (${reasons.get(project.name)})`)
      })().then(() => ({ name: project.name }), error => ({ name: project.name, error })))
    }
    const result = await Promise.race(running.values())
    running.delete(result.name)
    if (result.error) {
      await Promise.all(running.values())
      throw result.error
    }
    done.add(result.name)
  }
  return plan
}
