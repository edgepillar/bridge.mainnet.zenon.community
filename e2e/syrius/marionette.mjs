import net from 'node:net'
import { spawn } from 'node:child_process'
import fs from 'node:fs'

export async function launchFirefox({ profile, port = 2828, prefs = {} }) {
  fs.mkdirSync(profile, { recursive: true })
  const all = { 'marionette.port': port, 'xpinstall.signatures.required': false, 'browser.shell.checkDefaultBrowser': false,
    'datareporting.policy.dataSubmissionEnabled': false, 'browser.startup.homepage_override.mstone': 'ignore', 'extensions.autoDisableScopes': 0, ...prefs }
  fs.writeFileSync(`${profile}/user.js`, Object.entries(all).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n'))
  const proc = spawn(process.env.FIREFOX_PATH || '/usr/bin/firefox-esr', ['--marionette', '-remote-allow-system-access', '--headless', '--no-remote', '--profile', profile, '--width', '1280', '--height', '900'], { stdio: 'ignore' })
  for (let i = 0; i < 60; i++) {
    try { const c = await connect(port); return { proc, client: c } } catch { await new Promise((r) => setTimeout(r, 500)) }
  }
  proc.kill(); throw new Error('Marionette did not start')
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1')
    let buf = Buffer.alloc(0), greeted = false, next = 1
    const waiting = new Map()
    sock.on('error', reject)
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      for (;;) {
        const colon = buf.indexOf(58)
        if (colon < 0) return
        const len = Number(buf.subarray(0, colon).toString())
        if (buf.length < colon + 1 + len) return
        const msg = JSON.parse(buf.subarray(colon + 1, colon + 1 + len).toString())
        buf = buf.subarray(colon + 1 + len)
        if (!greeted) { greeted = true; resolve(client); continue }
        const [, id, error, result] = msg
        const w = waiting.get(id); waiting.delete(id)
        if (!w) continue
        if (error) w.reject(Object.assign(new Error(`${error.error}: ${error.message}`), { mn: error }))
        else w.resolve(result)
      }
    })
    const client = {
      send(name, params = {}) {
        const id = next++
        const body = Buffer.from(JSON.stringify([0, id, name, params]))
        sock.write(Buffer.concat([Buffer.from(`${body.length}:`), body]))
        return new Promise((res, rej) => waiting.set(id, { resolve: res, reject: rej }))
      },
      close() { sock.destroy() },
    }
  })
}

export function session(c) {
  const s = {
    start: () => c.send('WebDriver:NewSession', { capabilities: { alwaysMatch: { acceptInsecureCerts: true } } }),
    context: (value) => c.send('Marionette:SetContext', { value }),
    install: (path) => c.send('Addon:Install', { path, temporary: true }),
    exec: async (body, args = []) => (await c.send('WebDriver:ExecuteScript', { script: body, args, sandbox: null }))?.value,
    execAsync: async (body, args = [], timeout = 60000) => (await c.send('WebDriver:ExecuteAsyncScript', { script: body, args, scriptTimeout: timeout }))?.value,
    go: (url) => c.send('WebDriver:Navigate', { url }),
    url: async () => (await c.send('WebDriver:GetCurrentURL'))?.value,
    handles: async () => (await c.send('WebDriver:GetWindowHandles')) ?? [],
    handle: async () => (await c.send('WebDriver:GetWindowHandle'))?.value,
    switchTo: (handle) => c.send('WebDriver:SwitchToWindow', { handle, focus: true }),
    newTab: async () => (await c.send('WebDriver:NewWindow', { type: 'tab' })).handle,
    close: () => c.send('WebDriver:CloseWindow'),
    shot: async (file) => { const r = await c.send('WebDriver:TakeScreenshot', { full: false, hash: false }); fs.writeFileSync(file, Buffer.from(r.value, 'base64')) },
    text: () => s.exec('return document.body ? document.body.innerText : ""'),
  }
  return s
}
