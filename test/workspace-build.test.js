import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { buildWorkspace, discoverBuildProjects } from '../exports/workspace-build.js'

const run = promisify(execFile)
const cli = fileURLToPath(new URL('../exports/cli.js', import.meta.url))
const fixture = async (patterns = ['packages/*']) => {
  const root = await mkdtemp(join(tmpdir(), 'rage-workspace-'))
  const trace = join(root, 'trace.txt')
  const save = async (path, content) => {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), content)
  }
  await save('package.json', JSON.stringify({ private: true, type: 'module', workspaces: patterns, scripts: { build: 'rage build' } }))
  const project = async (directory, name, dependencies = {}, script) => {
    const manifest = { name, version: '1.0.0', private: true, type: 'module', dependencies }
    if (script !== false) {
      manifest.main = './dist/index.js'
      manifest.scripts = { build: 'node build.js' }
      await save(`${directory}/build.js`, script ?? `
        import {appendFileSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
        appendFileSync(${JSON.stringify(trace)}, ${JSON.stringify(name + '\n')});
        mkdirSync('dist',{recursive:true});
        writeFileSync('dist/index.js',readFileSync('src/value.txt','utf8'));
      `)
    }
    await save(`${directory}/package.json`, JSON.stringify(manifest))
    await save(`${directory}/src/value.txt`, name)
  }
  const lines = async () => {
    try { return (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean) }
    catch (error) { if (error.code === 'ENOENT') return []; throw error }
  }
  return { root, save, project, lines, clean: () => rm(root, { recursive: true, force: true }) }
}
const built = plan => plan.filter(project => project.build).map(project => project.name).sort()

test('discovers declared nested/brace workspaces, exclusions and scoped names; ignores non-workspaces', async () => {
  const f = await fixture({ packages: ['modules/{one,two}/*', '!modules/two/excluded'] })
  try {
    await f.project('modules/one/core', '@test/core')
    await f.project('modules/two/ui', '@test/ui', { '@test/core': '^1.0.0' })
    await f.project('modules/two/excluded', '@test/ignored')
    await f.project('packages/not-declared', '@test/also-ignored')
    const projects = await discoverBuildProjects(f.root)
    assert.deepEqual(projects.map(project => project.name), ['@test/core', '@test/ui'])
    assert.deepEqual(projects[1].dependencies, ['@test/core'])
    const before = await f.lines()
    const plan = await buildWorkspace({ cwd: f.root, dryRun: true })
    assert.deepEqual(built(plan), ['@test/core', '@test/ui'])
    assert.deepEqual(await f.lines(), before)
    await assert.rejects(readFile(join(f.root, '.builder-cache/build-v2.json')), { code: 'ENOENT' })
  } finally { await f.clean() }
})

test('builds dependencies before dependants, including through a no-build workspace; priority never breaks edges', async () => {
  const f = await fixture()
  try {
    await f.project('packages/a', '@test/app', { '@test/bridge': '*' })
    await f.project('packages/b', '@test/bridge', { '@test/core': '*' }, false)
    await f.project('packages/c', '@test/core')
    const plan = await buildWorkspace({ cwd: f.root, all: true, priority: ['a'], jobs: 3 })
    assert.deepEqual(await f.lines(), ['@test/core', '@test/app'])
    assert.equal(plan.find(project => project.name === '@test/bridge').reason, 'no build script')
    assert.equal(plan.find(project => project.name === '@test/bridge').build, false)
  } finally { await f.clean() }
})

test('unchanged builds hit cache; changed/deleted files rebuild their reverse dependencies only', async () => {
  const f = await fixture()
  try {
    await f.project('packages/a', 'a')
    await f.project('packages/b', 'b', { a: '*' })
    await f.project('packages/c', 'c')
    await f.save('packages/a/src/extra.txt', 'included')
    await buildWorkspace({ cwd: f.root, jobs: 2 })
    assert.deepEqual(built(await buildWorkspace({ cwd: f.root })), [])
    assert.equal((await f.lines()).length, 3)
    await f.save('packages/a/src/value.txt', 'modified')
    assert.deepEqual(built(await buildWorkspace({ cwd: f.root })), ['a', 'b'])
    await rm(join(f.root, 'packages/a/src/extra.txt'))
    assert.deepEqual(built(await buildWorkspace({ cwd: f.root })), ['a', 'b'])
    // Changes in a source-only workspace also invalidate its consumers.
    await f.project('packages/helper', 'helper', {}, false)
    await f.project('packages/b', 'b', { a: '*', helper: '*' })
    await buildWorkspace({ cwd: f.root })
    await f.save('packages/helper/src/value.txt', 'new helper source')
    assert.deepEqual(built(await buildWorkspace({ cwd: f.root })), ['b'])
  } finally { await f.clean() }
})

test('lockfiles and shared build helpers invalidate the full graph; missing output forces a rebuild', async () => {
  const f = await fixture()
  try {
    await f.project('packages/a', 'a')
    await f.project('packages/b', 'b')
    const manifest = JSON.parse(await readFile(join(f.root, 'packages/a/package.json'), 'utf8'))
    manifest.typings = './legacy-types/index.d.ts'
    await f.save('packages/a/package.json', JSON.stringify(manifest))
    await buildWorkspace({ cwd: f.root })
    assert.deepEqual(built(await buildWorkspace({ cwd: f.root })), [], 'unused legacy manifest targets do not cause rebuild loops')
    await f.save('package-lock.json', '{"lockfileVersion":3}')
    assert.deepEqual(built(await buildWorkspace({ cwd: f.root })), ['a', 'b'])
    await f.save('scripts/shared.js', 'export default 1')
    assert.deepEqual(built(await buildWorkspace({ cwd: f.root })), ['a', 'b'])
    await rm(join(f.root, 'packages/a/dist/index.js'))
    const plan = await buildWorkspace({ cwd: f.root })
    assert.deepEqual(built(plan), ['a'])
    assert.equal(plan.find(project => project.name === 'a').reason, 'missing output')
  } finally { await f.clean() }
})

test('failed forced builds revoke old cache successes, retry, and never run dependants', async () => {
  const f = await fixture()
  try {
    const trigger = join(f.root, 'failure-trigger')
    await f.project('packages/a', 'a', {}, `
      import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
      mkdirSync('dist',{recursive:true});writeFileSync('dist/index.js','output');
      if(existsSync(${JSON.stringify(trigger)})){console.error('REAL_BUILD_FAILURE');process.exit(7)}
    `)
    await f.project('packages/b', 'b', { a: '*' })
    await buildWorkspace({ cwd: f.root })
    await f.save('failure-trigger', 'fail without changing build inputs')
    await assert.rejects(buildWorkspace({ cwd: f.root, all: true }), /build failed: a.*\(7\)[\s\S]*REAL_BUILD_FAILURE/)
    await assert.rejects(buildWorkspace({ cwd: f.root }), /REAL_BUILD_FAILURE/)
    assert.deepEqual(await f.lines(), ['b'])
    await rm(trigger)
    assert.deepEqual(built(await buildWorkspace({ cwd: f.root })), ['a'])
  } finally { await f.clean() }
})

test('detects cycles and duplicate workspace names before launching scripts', async () => {
  const f = await fixture()
  try {
    await f.project('packages/a', 'a', { b: '*' })
    await f.project('packages/b', 'b', { a: '*' })
    await assert.rejects(buildWorkspace({ cwd: f.root }), /workspace dependency cycle: a -> b -> a/)
    assert.deepEqual(await f.lines(), [])
    await f.project('packages/b', 'a')
    await assert.rejects(buildWorkspace({ cwd: f.root }), /duplicate workspace name: a/)
  } finally { await f.clean() }
})

test('honors local version ranges and build-time dev/optional/peer dependencies', async () => {
  const f = await fixture()
  try {
    await f.project('packages/a', 'a')
    await f.project('packages/b', 'b', { a: '^2.0.0' })
    let projects = await discoverBuildProjects(f.root)
    assert.deepEqual(projects.find(project => project.name === 'b').dependencies, [])
    for (const section of ['devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const manifest = { name: 'b', version: '1.0.0', [section]: { a: '*' } }
      await f.save('packages/b/package.json', JSON.stringify(manifest))
      projects = await discoverBuildProjects(f.root)
      assert.deepEqual(projects.find(project => project.name === 'b').dependencies, ['a'])
    }
  } finally { await f.clean() }
})

test('supports standalone and legacy packages roots without executing the wrapper recursively', async () => {
  const f = await fixture()
  try {
    await f.project('packages/a', 'a')
    await f.save('package.json', JSON.stringify({ name: 'root', scripts: { build: 'rage --build' } }))
    await assert.rejects(buildWorkspace({ cwd: f.root }), /avoid recursion/)
    assert.deepEqual(built(await buildWorkspace({ cwd: f.root, legacyRoot: 'packages' })), ['a'])
    assert.deepEqual(built(await buildWorkspace({ cwd: join(f.root, 'packages/a') })), ['a'])
  } finally { await f.clean() }
})

test('CLI skips packages without scripts and returns nonzero on real build failures', async () => {
  const f = await fixture()
  try {
    await f.project('packages/faucet', '@test/faucet', {}, false)
    const { stdout } = await run(process.execPath, [cli, '--build', '--all', '--jobs', '2'], { cwd: f.root })
    assert.match(stdout, /SKIP @test\/faucet \(no build script\)/)
    await f.project('packages/failing', '@test/failing', {}, 'process.exit(9)')
    await assert.rejects(run(process.execPath, [cli, 'build'], { cwd: f.root }), error => error.code === 1 && /build failed: @test\/failing/.test(error.stderr))
    await assert.rejects(run(process.execPath, [cli, 'build', '--jobs', '0'], { cwd: f.root }), /positive integer/)
  } finally { await f.clean() }
})

test('timeouts terminate the build and never cache its partial outputs', async () => {
  const f = await fixture()
  try {
    await f.project('packages/slow', 'slow', {}, 'setInterval(()=>{},1000)')
    await assert.rejects(buildWorkspace({ cwd: f.root, timeoutMs: 300 }), /build timed out after 300ms: slow/)
    const cache = JSON.parse(await readFile(join(f.root, '.builder-cache/build-v2.json'), 'utf8'))
    assert.equal(cache.projects['packages/slow'], undefined)
  } finally { await f.clean() }
})

test('malformed workspace declarations and paths outside the root fail closed', async () => {
  const f = await fixture()
  try {
    await f.save('package.json', JSON.stringify({ workspaces: 'packages/*' }))
    await assert.rejects(discoverBuildProjects(f.root), /workspaces must be an array/)
    await f.save('package.json', JSON.stringify({ workspaces: ['../*'] }))
    await assert.rejects(discoverBuildProjects(f.root), /escapes root/)
  } finally { await f.clean() }
})

test('independent projects run concurrently without exceeding the jobs limit', async () => {
  const f = await fixture()
  try {
    const trace = join(f.root, 'trace.txt')
    for (const name of ['a', 'b', 'c', 'd']) {
      await f.project(`packages/${name}`, name, {}, `
        import {appendFileSync,mkdirSync,writeFileSync} from 'node:fs';
        appendFileSync(${JSON.stringify(trace)},'start:${name}\\n');
        setTimeout(()=>{
          mkdirSync('dist',{recursive:true});writeFileSync('dist/index.js','built');
          appendFileSync(${JSON.stringify(trace)},'end:${name}\\n');
        },250);
      `)
    }
    await buildWorkspace({ cwd: f.root, jobs: 2 })
    let active = 0
    let maximum = 0
    for (const line of await f.lines()) {
      active += line.startsWith('start:') ? 1 : -1
      maximum = Math.max(maximum, active)
      assert.ok(active >= 0 && active <= 2)
    }
    assert.equal(active, 0)
    assert.equal(maximum, 2)
  } finally { await f.clean() }
})

test('build scripts without a src directory are not silently dropped', async () => {
  const f = await fixture()
  try {
    await f.project('packages/config-only', 'config-only', {}, "import{mkdirSync,writeFileSync}from'node:fs';mkdirSync('dist');writeFileSync('dist/index.js','built')")
    await rm(join(f.root, 'packages/config-only/src'), { recursive: true })
    assert.deepEqual(built(await buildWorkspace({ cwd: f.root })), ['config-only'])
    assert.deepEqual(built(await buildWorkspace({ cwd: f.root })), [])
  } finally { await f.clean() }
})

test('npm workspace lifecycle preserves the root prefix and the package working directory', async () => {
  const f = await fixture()
  try {
    await f.project('packages/context', 'context', {}, `
      import assert from 'node:assert/strict';
      import {mkdirSync,realpathSync,writeFileSync} from 'node:fs';
      assert.equal(realpathSync.native(process.env.npm_config_local_prefix),realpathSync.native(${JSON.stringify(f.root)}));
      assert.equal(realpathSync.native(process.cwd()),realpathSync.native(${JSON.stringify(join(f.root, 'packages/context'))}));
      mkdirSync('dist');writeFileSync('dist/index.js','built');
    `)
    assert.deepEqual(built(await buildWorkspace({ cwd: f.root })), ['context'])
  } finally { await f.clean() }
})

test('root build wrappers fail on indirect recursion, but ordinary scripts may mention rage', async () => {
  const f = await fixture()
  try {
    await f.save('package.json', JSON.stringify({ name: 'root', scripts: { build: 'node -e "console.log(\'rage\')"' } }))
    assert.deepEqual(built(await buildWorkspace({ cwd: f.root })), ['root'])
    await f.save('package.json', JSON.stringify({ name: 'root', scripts: { build: `node ${JSON.stringify(cli)} build` } }))
    await assert.rejects(buildWorkspace({ cwd: f.root, timeoutMs: 5000 }), /recursive build invocation/)
  } finally { await f.clean() }
})
