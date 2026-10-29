import './style.css'

function framedByAnotherSite(): boolean {
  try {
    return window.top !== window.self && window.top!.location.origin !== location.origin
  } catch {
    return true
  }
}

if (framedByAnotherSite()) {
  const a = document.createElement('a')
  a.href = location.href
  a.target = '_top'
  a.rel = 'noopener'
  a.className = 'link'
  a.textContent = 'Open the bridge in its own tab'
  const p = document.createElement('p')
  p.style.cssText = 'padding:24px;font:15px system-ui,sans-serif'
  p.append(a)
  document.getElementById('app')!.replaceChildren(p)
} else {
  void import('./app.ts')
}
