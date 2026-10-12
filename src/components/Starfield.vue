<script setup lang="ts">
// The page background: a field of small stars drifting slowly outward from
// the centre, as if the page were travelling into it. Stars are Zenon green
// and quasar blue at varying brightness.
//
// Each star has a place in a cone ahead of the viewer and a depth. Depth
// shrinks a little every frame, so the star's projection moves away from the
// centre and grows; one that leaves the screen starts again far away. The
// speed is low on purpose: a star takes about two minutes to cross.
//
// Stars near the pointer light up: brighter, larger, with a soft halo, fading
// with distance and after the pointer leaves the page.
//
// It always runs. There is no reduced-motion branch here and there must not
// be one (webdesign-lab/RULES.md section 4).
import { onBeforeUnmount, onMounted, ref } from 'vue'

const canvas = ref<HTMLCanvasElement | null>(null)

interface Star {
  x: number
  y: number
  z: number
  hue: number
  light: number
  size: number
  twinkle: number
}

// Green around the ZNN mark's hue, blue around quasar's.
const GREEN = 142
const BLUE = 216
const DEPTH = 1
const NEAR = 0.08
/** Depth lost per second: a full crossing takes DEPTH / SPEED seconds. */
const SPEED = 0.0085
/** Stars within this many pixels of the pointer are lit. */
const REACH = 170

let raf = 0
let stars: Star[] = []
let w = 0
let h = 0
let dpr = 1
let last = 0
// The pointer, and how lit its surroundings are (eases to 0 when it leaves).
let mx = -1e4
let my = -1e4
let lit = 0
let litTarget = 0

function onMove(e: PointerEvent) {
  mx = e.clientX
  my = e.clientY
  litTarget = 1
}
function onLeave() {
  litTarget = 0
}

function spawn(z: number): Star {
  const green = Math.random() < 0.55
  return {
    x: (Math.random() * 2 - 1) * 1.4,
    y: (Math.random() * 2 - 1) * 1.4,
    z,
    hue: (green ? GREEN : BLUE) + (Math.random() * 16 - 8),
    light: 55 + Math.random() * 30,
    size: 0.5 + Math.random() * 0.9,
    twinkle: Math.random() * Math.PI * 2,
  }
}

function resize() {
  const c = canvas.value
  if (!c) return
  dpr = Math.min(window.devicePixelRatio || 1, 2)
  w = window.innerWidth
  h = window.innerHeight
  c.width = Math.round(w * dpr)
  c.height = Math.round(h * dpr)
  // About one star per 5,500 px², within bounds a phone and a 4K screen both draw easily.
  const want = Math.max(120, Math.min(420, Math.round((w * h) / 5500)))
  while (stars.length < want) stars.push(spawn(NEAR + Math.random() * (DEPTH - NEAR)))
  stars.length = want
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fill()
}

function frame(now: number) {
  raf = requestAnimationFrame(frame)
  const c = canvas.value
  const ctx = c?.getContext('2d')
  if (!c || !ctx) return
  // A tab left in the background comes back with one long gap; treat it as a frame.
  const dt = Math.min(0.05, (now - last) / 1000 || 0)
  last = now
  const set = document.documentElement.getAttribute('data-theme')
  const light = set === 'light' || (!set && matchMedia('(prefers-color-scheme: light)').matches)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  const cx = w / 2
  const cy = h * 0.42
  const scale = Math.max(w, h) * 0.5
  lit += (litTarget - lit) * Math.min(1, dt * 6)
  for (let i = 0; i < stars.length; i++) {
    const s = stars[i]
    s.z -= SPEED * dt
    const px = cx + (s.x / s.z) * scale * NEAR * 4
    const py = cy + (s.y / s.z) * scale * NEAR * 4
    if (s.z <= NEAR || px < -20 || px > w + 20 || py < -20 || py > h + 20) {
      stars[i] = spawn(DEPTH)
      continue
    }
    // Far stars are faint and small; they brighten as they come.
    const near = 1 - (s.z - NEAR) / (DEPTH - NEAR)
    const fadeIn = Math.min(1, (DEPTH - s.z) / 0.08)
    const flicker = 0.85 + 0.15 * Math.sin(now / 900 + s.twinkle)
    const dist = Math.hypot(px - mx, py - my)
    const glow = dist < REACH ? (1 - dist / REACH) ** 2 * lit : 0
    const alpha = Math.min(1, (0.18 + near * 0.72) * fadeIn * flicker * (light ? 0.55 : 1) + glow * 0.9)
    const r = s.size * (0.6 + near * 1.5) * (1 + glow * 1.6)
    const lightness = (light ? s.light - 30 : s.light) + glow * (light ? -10 : 18)
    if (glow > 0.02) dot(ctx, px, py, r * 4, `hsl(${s.hue} 90% ${lightness}% / ${(glow * 0.22).toFixed(3)})`)
    dot(ctx, px, py, r, `hsl(${s.hue} ${light ? 70 : 85}% ${lightness}% / ${alpha.toFixed(3)})`)
  }
}

onMounted(() => {
  resize()
  window.addEventListener('resize', resize)
  window.addEventListener('pointermove', onMove, { passive: true })
  document.documentElement.addEventListener('pointerleave', onLeave)
  raf = requestAnimationFrame(frame)
})
onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  window.removeEventListener('resize', resize)
  window.removeEventListener('pointermove', onMove)
  document.documentElement.removeEventListener('pointerleave', onLeave)
})
</script>

<template>
  <canvas ref="canvas" class="starfield" aria-hidden="true" />
</template>

<style scoped>
.starfield {
  position: fixed;
  inset: 0;
  z-index: -1;
  width: 100vw;
  height: 100vh;
  pointer-events: none;
}
</style>
