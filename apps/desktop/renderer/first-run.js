const api = window.dshDesktop

const PHASE_MESSAGE = {
  verifying: 'setupVerifying', store: 'setupStore', installing: 'setupInstalling',
  health: 'setupHealth', activating: 'setupActivating', starting: 'setupStarting', ready: 'setupReady',
}

function startParticles() {
  const canvas = document.querySelector('#particles')
  const context = canvas.getContext('2d')
  const logo = document.querySelector('#logo')
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  if (context === null) { document.body.classList.add('static'); return () => {} }
  let frame = 0
  let disposed = false
  let began = performance.now()
  let lastFrame = 0
  let width = 0
  let height = 0
  let points = []
  const dust = Array.from({ length: 52 }, () => ({ x: Math.random(), y: Math.random(), r: .5 + Math.random(), phase: Math.random() * Math.PI * 2 }))

  function resize() {
    width = innerWidth
    height = innerHeight
    const ratio = Math.min(devicePixelRatio || 1, 1.5)
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    if (!logo.complete || logo.naturalWidth === 0) return
    const sample = document.createElement('canvas')
    sample.width = 120
    sample.height = 104
    const brush = sample.getContext('2d', { willReadFrequently: true })
    if (brush === null) return
    brush.drawImage(logo, 0, 0, sample.width, sample.height)
    const pixels = brush.getImageData(0, 0, sample.width, sample.height).data
    const rect = logo.getBoundingClientRect()
    points = []
    for (let y = 0; y < sample.height; y += 4) {
      for (let x = 0; x < sample.width; x += 4) {
        if (pixels[(y * sample.width + x) * 4 + 3] < 100) continue
        const angle = Math.random() * Math.PI * 2
        const radius = 80 + Math.random() * 190
        points.push({ x: rect.left + x / sample.width * rect.width, y: rect.top + y / sample.height * rect.height,
          dx: Math.cos(angle) * radius, dy: Math.sin(angle) * radius, delay: Math.random() * .32, r: .65 + Math.random() * .7 })
      }
    }
  }

  function draw(now) {
    frame = 0
    if (disposed || document.hidden || reduced.matches) return
    frame = requestAnimationFrame(draw)
    if (now - lastFrame < 1000 / 30) return
    lastFrame = now
    const elapsed = (now - began) / 1000
    context.clearRect(0, 0, width, height)
    for (const p of dust) {
      const x = p.x * width + Math.sin(elapsed * .16 + p.phase) * 11
      const y = (p.y * height - elapsed * 2.5 + height * 100) % height
      context.fillStyle = `rgba(151,183,255,${.13 + (Math.sin(elapsed * .55 + p.phase) + 1) * .12})`
      context.beginPath(); context.arc(x, y, p.r, 0, Math.PI * 2); context.fill()
    }
    const fade = Math.max(0, 1 - Math.max(0, elapsed - 1.55) / .8)
    if (fade > 0) {
      for (const p of points) {
        const t = Math.min(1, Math.max(0, (elapsed - p.delay) / 1.45))
        const remaining = (1 - t) ** 3
        context.fillStyle = `rgba(116,157,255,${fade * (.35 + t * .65)})`
        context.beginPath(); context.arc(p.x + p.dx * remaining, p.y + p.dy * remaining, p.r, 0, Math.PI * 2); context.fill()
      }
    }
    if (elapsed > 1.5) document.body.classList.add('assembled')
  }

  function schedule() {
    cancelAnimationFrame(frame)
    frame = 0
    document.body.classList.toggle('static', reduced.matches)
    if (reduced.matches) context.clearRect(0, 0, width, height)
    else if (!document.hidden && !disposed) frame = requestAnimationFrame(draw)
  }
  const loaded = () => { resize(); began = performance.now(); schedule() }
  logo.addEventListener('load', loaded)
  logo.addEventListener('error', () => { document.body.classList.add('static') }, { once: true })
  addEventListener('resize', resize)
  document.addEventListener('visibilitychange', schedule)
  reduced.addEventListener('change', schedule)
  resize()
  schedule()
  return () => {
    disposed = true
    cancelAnimationFrame(frame)
    logo.removeEventListener('load', loaded)
    removeEventListener('resize', resize)
    document.removeEventListener('visibilitychange', schedule)
    reduced.removeEventListener('change', schedule)
  }
}

async function main() {
  const locale = await api.locale()
  const messages = locale.messages
  document.documentElement.lang = locale.id
  for (const [id, key] of Object.entries({ 'page-title': 'setupWindowTitle', title: 'setupTitle', description: 'setupDescription',
    footnote: 'setupFootnote', 'step-verify': 'setupStepVerify', 'step-prepare': 'setupStepPrepare', 'step-open': 'setupStepOpen' })) {
    document.getElementById(id).textContent = messages[key]
  }
  const status = document.querySelector('#status')
  const progress = document.querySelector('#progress')
  progress.setAttribute('aria-label', messages.setupInstalling)
  const steps = [...document.querySelectorAll('.steps span')]
  const stopParticles = startParticles()
  const unsubscribe = api.setup.subscribe(state => {
    status.textContent = messages[PHASE_MESSAGE[state.phase]] ?? ''
    const measured = state.phase === 'installing' && state.totalBytes > 0 && Number.isFinite(state.completedBytes)
    if (measured) {
      const percent = Math.min(100, Math.max(0, Math.floor(state.completedBytes / state.totalBytes * 100)))
      progress.value = percent
      status.textContent = messages.setupProgress.replace('{percent}', String(percent))
    } else if (state.phase === 'ready') progress.value = 100
    else progress.removeAttribute('value')
    const active = state.phase === 'verifying' ? 0 : ['store', 'installing', 'health'].includes(state.phase) ? 1 : 2
    steps.forEach((step, index) => { step.classList.toggle('active', index === active); step.classList.toggle('done', index < active) })
    if (state.phase === 'ready') { document.body.classList.add('ready'); stopParticles() }
  })
  addEventListener('pagehide', () => { unsubscribe(); stopParticles() }, { once: true })
}

void main()
