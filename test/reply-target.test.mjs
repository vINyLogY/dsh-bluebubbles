import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {pickReplyTargetOverride} from '../src/lib.ts'

const TTL = 10 * 60 * 1000
const SESSION = 'session-synthetic'
const NOW = 1_800_000_000_000

test('pickReplyTargetOverride ignores missing/malformed/foreign-turn entries', () => {
  assert.equal(pickReplyTargetOverride(null, SESSION, NOW - 1000, NOW, TTL), null)
  assert.equal(pickReplyTargetOverride({}, SESSION, NOW - 1000, NOW, TTL), null)
  assert.equal(pickReplyTargetOverride({[SESSION]: 'x'}, SESSION, NOW - 1000, NOW, TTL), null)
  assert.equal(pickReplyTargetOverride({[SESSION]: {kind: 'chat'}}, SESSION, NOW - 1000, NOW, TTL), null)
  assert.equal(pickReplyTargetOverride({[SESSION]: {kind: 'bogus', setAt: NOW}}, SESSION, NOW - 1000, NOW, TTL), null)
  assert.equal(pickReplyTargetOverride({[SESSION]: {kind: 'chat', chatGuid: '' , setAt: NOW}}, SESSION, NOW - 1000, NOW, TTL), null)
  // armed by an older turn: never redirect the current one
  assert.equal(pickReplyTargetOverride({[SESSION]: {kind: 'none', setAt: NOW - 5000}}, SESSION, NOW - 1000, NOW, TTL), null)
  // expired with the relay trigger TTL
  assert.equal(pickReplyTargetOverride({[SESSION]: {kind: 'none', setAt: NOW - TTL - 1}}, SESSION, NOW - TTL - 2, NOW, TTL), null)
})

test('pickReplyTargetOverride returns the redirect and the silence form', () => {
  assert.deepEqual(pickReplyTargetOverride({[SESSION]: {kind: 'chat', chatGuid: 'any;-;+1', setAt: NOW}}, SESSION, NOW - 1000, NOW, TTL), {kind: 'chat', chatGuid: 'any;-;+1'})
  assert.deepEqual(pickReplyTargetOverride({[SESSION]: {kind: 'none', setAt: NOW}}, SESSION, NOW - 1000, NOW, TTL), {kind: 'none'})
  // exactly at the trigger timestamp still counts as the same turn
  assert.deepEqual(pickReplyTargetOverride({[SESSION]: {kind: 'none', setAt: NOW - 1000}}, SESSION, NOW - 1000, NOW, TTL), {kind: 'none'})
})

test('the shipped CLI writes, replaces and clears the reply-target table', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-cli-reply-target-'))
  t.after(() => rm(home, {recursive: true, force: true}))
  const path = join(home, 'bluebubbles-reply-target.json')
  const cli = (...args) => spawnSync(process.execPath, ['bin/bb-channel.mjs', ...args], {
    cwd: new URL('../', import.meta.url),
    env: {PATH: process.env.PATH, HOME: home, DSH_HOME: home, DSH_SESSION_ID: SESSION},
    encoding: 'utf8',
  })
  // no --session: falls back to DSH_SESSION_ID
  let run = cli('set-reply-target', '--none')
  assert.equal(run.status, 0, run.stderr)
  let table = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(table[SESSION].kind, 'none')
  // --chat replaces the same session entry
  run = cli('set-reply-target', '--chat', 'any;-;+8618813133211')
  assert.equal(run.status, 0, run.stderr)
  table = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(table[SESSION].kind, 'chat')
  assert.equal(table[SESSION].chatGuid, 'any;-;+8618813133211')
  assert.equal(typeof table[SESSION].setAt, 'number')
  // --origin clears it
  run = cli('set-reply-target', '--origin')
  assert.equal(run.status, 0, run.stderr)
  table = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(table[SESSION], undefined)
  // mutually exclusive modes
  assert.equal(cli('set-reply-target', '--none', '--origin').status, 1)
  assert.equal(cli('set-reply-target', '--chat', 'any;-;+1', '--none').status, 1)
  assert.equal(cli('set-reply-target').status, 1)
  // read back
  await writeFile(path, JSON.stringify({[SESSION]: {kind: 'none', setAt: Date.now()}}))
  run = cli('reply-target')
  assert.equal(run.status, 0, run.stderr)
  assert.equal(JSON.parse(run.stdout).overrides[SESSION].kind, 'none')
})

test('a session with no entry falls back to the origin chat', () => {
  const other = 'session-other'
  assert.equal(pickReplyTargetOverride({[other]: {kind: 'none', setAt: NOW}}, SESSION, NOW - 1, NOW, TTL), null)
})
