// Export pinned public source and apply checksum-bound lab overlays. Changes
// in the Go checkout's working tree never enter the lab.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { downloaderPhaseReset, resetDownloaderPhase } from './downloader-phase-reset.mjs'
const here = path.dirname(fileURLToPath(import.meta.url))
const pins = JSON.parse(fs.readFileSync(path.join(here, 'pins.json')))
const checkout = process.env.GO_ZENON_DIR
if (!checkout) throw new Error('Set GO_ZENON_DIR to the pinned go-zenon checkout')
const run = (command, args, options = {}) => execFileSync(command, args, { maxBuffer: 64 * 1024 * 1024, ...options })
const commit = run('git', ['-C', checkout, 'rev-parse', 'HEAD']).toString().trim()
const tree = run('git', ['-C', checkout, 'rev-parse', 'HEAD^{tree}']).toString().trim()
if (commit !== pins.goZenonCommit || tree !== pins.goZenonTree) throw new Error('go-zenon source does not match the pinned commit and tree')
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const build = path.join(here, '.build'), source = path.join(build, 'src')
fs.mkdirSync(build, { recursive: true })
const archive = run('git', ['-C', checkout, 'archive', pins.goZenonCommit])
const overlayNames = ['znnd/devnet_bridge.go', 'Dockerfile', 'make-assets.mjs', 'native.mjs', 'verify-build.mjs', 'build.mjs', 'pins.json', 'lab.sh', 'docker-compose.yml', 'docker-manifest.mjs', 'frontier.mjs', 'readiness.mjs', 'readiness.d.mts', 'native-diagnostics.mjs', 'native-diagnostics.d.mts', 'native-postmortem.mjs', 'native-postmortem.d.mts', 'downloader-phase-reset.mjs', 'downloader-phase-reset.d.mts', 'downloader-phase-control.mjs', 'downloader-phase-control.d.mts', 'downloader/phase_completion_test.go']
const overlayHashes = Object.fromEntries(overlayNames.map((name) => [name, digest(fs.readFileSync(path.join(here, name)))]))
const key = digest(JSON.stringify({ pins, archiveHash: digest(archive), overlayHashes }))
fs.rmSync(source, { recursive: true, force: true }); fs.mkdirSync(source, { recursive: true })
run('tar', ['-x', '-C', source], { input: archive })
fs.copyFileSync(path.join(here, 'znnd/devnet_bridge.go'), path.join(source, 'vm/constants/devnet_bridge.go'))
if(commit!==downloaderPhaseReset.sourceCommit||tree!==downloaderPhaseReset.sourceTree)throw new Error('Downloader phase patch source pin mismatch')
const downloaderFile=path.join(source,'protocol/downloader/downloader.go')
fs.writeFileSync(downloaderFile,resetDownloaderPhase(fs.readFileSync(downloaderFile)))
const mode = process.argv[2] ?? 'native'
const manifest = { sourceCommit: commit, sourceTree: tree, archiveHash: digest(archive),
  downloaderSourceHash: digest(fs.readFileSync(downloaderFile)), downloaderPatch:downloaderPhaseReset, overlayHashes, key, mode, pins }
if (mode === 'native') {
  const go = process.env.LAB_GO_BIN || 'go'
  const version = run(go, ['version']).toString().trim()
  if (!version.includes(`go${pins.goVersion} `)) throw new Error('Go compiler does not match the pinned version')
  run(go, ['build', '-trimpath', '-buildvcs=false', '-o', path.join(build, 'znnd'), './cmd/znnd'], { cwd: source, stdio: 'inherit', env: { ...process.env, GOTOOLCHAIN: 'local' } })
  Object.assign(manifest, { goVersion: version, binaryHash: digest(fs.readFileSync(path.join(build, 'znnd'))) })
} else if (mode === 'docker') {
  const tag = `${commit.slice(0,12)}-${key.slice(0,16)}`
  run('docker', ['build', '-f', path.join(here, 'Dockerfile'), '--build-arg', `GO_IMAGE=${pins.goImage}`, '--build-arg', `RUNTIME_IMAGE=${pins.runtimeImage}`, '-t', `bridge-lab-znnd:${tag}`, source], { stdio: 'inherit' })
  Object.assign(manifest, { imageId: run('docker', ['image', 'inspect', '--format', '{{.Id}}', `bridge-lab-znnd:${tag}`]).toString().trim() })
  fs.writeFileSync(path.join(build, 'revision'), tag + '\n')
} else throw new Error('Choose native or docker lab build')
fs.writeFileSync(path.join(build, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`Pinned lab build complete: ${key}`)
