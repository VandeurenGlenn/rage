// Run after npm test: reuse its compiled output, install only the public tarball.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = fileURLToPath(new URL('..', import.meta.url))
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'rage-package-')))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const run = (command, args, cwd = temporary) => {
  // This verification is launched through npm run test:package, which supplies
  // npm's JS entrypoint. Execute that with Node instead of shell:true + args.
  if (process.platform === 'win32' && command === npm) {
    assert.ok(process.env.npm_execpath, 'run this check through npm run test:package')
    args = [process.env.npm_execpath, ...args]
    command = process.execPath
  }
  return execFileSync(command, args, {
    cwd, timeout: 120_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  })
}
try {
  const [packed] = JSON.parse(run(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], project))
  assert.ok(packed.files.some(file => file.path === 'exports/workspace-build.js'))
  assert.ok(packed.files.every(file => !/^(src|test|node_modules|\.builder-cache)\//.test(file.path)))
  writeFileSync(join(temporary, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'] }))
  run(npm, ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', join(temporary, packed.filename)])
  const lock = JSON.parse(readFileSync(join(temporary, 'package-lock.json'), 'utf8'))
  assert.ok(!Object.keys(lock.packages).some(path => path.endsWith('node_modules/typescript')))
  for (const name of ['faucet', 'core']) mkdirSync(join(temporary, 'packages', name), { recursive: true })
  writeFileSync(join(temporary, 'packages/faucet/package.json'), JSON.stringify({ name: 'faucet', version: '1.0.0' }))
  writeFileSync(join(temporary, 'packages/core/package.json'), JSON.stringify({
    name: 'core', version: '1.0.0', scripts: { build: 'node -e "console.log(\'PACKED_CORE_READY\')"' }
  }))
  const cli = join(temporary, 'node_modules/@vandeurenglenn/rage/exports/cli.js')
  assert.match(run(process.execPath, [cli, '--help']), /--dry-run/)
  const output = run(process.execPath, [cli, 'build', '--all', '--log', '--jobs', '2'])
  assert.match(output, /SKIP faucet \(no build script\)/)
  assert.match(output, /PACKED_CORE_READY/)
  console.log('PASS: standalone tarball builds npm workspaces without a TypeScript runtime dependency')
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout)
  if (error.stderr) process.stderr.write(error.stderr)
  throw error
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
