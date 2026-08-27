// Integration test: prove the package installs through the real consumer path —
// `dsh plugin --profile <name> add <spec>` on a throwaway $DSH_HOME — and that
// its bundle layer (cordis.patch.yml rows) lands in the composed profile tree.
//
// Usage: node test/integration.mjs [package-spec]
//   Default spec is the repo root (local path). CI passes the git URL so the
//   test exercises exactly what a user would install.
//
// Never runs against a real DSH_HOME: it sets DSH_HOME to a mktemp dir for
// every dsh invocation, so the user's profiles and sessions are untouched.

import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const spec = process.argv[2] || repoRoot
const dshHome = mkdtempSync(join(tmpdir(), 'dsh-bb-it-'))
const PROFILE = 'it'

function fail(msg) {
  console.error('integration: FAIL — ' + msg)
  process.exit(1)
}

// CLI resolution order: DSH_BIN (explicit bin.js path) → the repo's own
// devDependency (npm ci already fetched it — the CI path) → npx @latest.
// The npx fallback sets npm_config_legacy_peer_deps: npm's default peer
// resolution spins for many minutes on the dsh tree (observed burning ~90%
// CPU on both macOS and the GitHub runner until it ETIMEDOUT).
const localBin = join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

function dsh(args) {
  const env = { ...process.env, DSH_HOME: dshHome, npm_config_legacy_peer_deps: 'true' }
  const bin = process.env.DSH_BIN || (existsSync(localBin) ? localBin : null)
  const run = bin
    ? spawnSync('node', [bin, ...args], { env, encoding: 'utf8', timeout: 300000 })
    : spawnSync('npx', ['-y', '@deepseek-ai/dsh@latest', ...args], { env, encoding: 'utf8', timeout: 600000 })
  if (run.error) fail(`spawn failed: ${run.error.message}`)
  if (run.status !== 0) fail(`dsh ${args.join(' ')} exited ${run.status}\n${run.stderr}\n${run.stdout}`.slice(0, 4000))
  return run.stdout
}

console.log(`integration: DSH_HOME=${dshHome} spec=${spec}`)

// 1. Install through the consumer entry point.
dsh(['plugin', '--profile', PROFILE, 'add', spec])

// 2. The dependency and the bundle layer must both be recorded.
const manifestPath = join(dshHome, 'profiles', PROFILE, 'package.json')
if (!existsSync(manifestPath)) fail(`profile manifest missing at ${manifestPath}`)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (!manifest.dependencies || !manifest.dependencies['dsh-bluebubbles']) {
  fail('dsh-bluebubbles not recorded as a profile dependency')
}
const bundles = manifest.dsh?.profile?.bundles ?? []
if (!bundles.includes('dsh-bluebubbles')) {
  fail(`dsh-bluebubbles did not join dsh.profile.bundles (got ${JSON.stringify(bundles)}) — dsh.bundle.patch declaration not picked up`)
}

// 3. The composed tree must contain all three plugin rows.
const tree = dsh(['--profile', PROFILE, '--dump-config'])
for (const id of ['bluebubbles-bridge', 'dsh-heartbeat', 'dsh-cron']) {
  if (!tree.includes(`id: ${id}`)) fail(`composed tree is missing row "${id}"`)
}

// 4. Entry points must resolve from the profile's node_modules.
const resolveRun = spawnSync('node', ['--input-type=module', '-e', `
  const specs = ['dsh-bluebubbles', 'dsh-bluebubbles/heartbeat', 'dsh-bluebubbles/cron']
  for (const s of specs) console.log(s + ' -> ' + import.meta.resolve(s))
`], { cwd: join(dshHome, 'profiles', PROFILE), encoding: 'utf8' })
if (resolveRun.status !== 0) fail(`subpath resolution failed:\n${resolveRun.stderr}`)
for (const line of resolveRun.stdout.trim().split('\n')) console.log('integration: ' + line)

console.log('integration: PASS')
