/** Bounded interactive canvas scene for the desktop startup window. */

/**
 * Animate the DeepSeek mark and orbital field; hidden and reduced-motion pages stop drawing.
 * @returns {() => void} Idempotent disposer for frames and scene event listeners.
 */
export function startParticles() {
  const canvas = document.querySelector('#particles')
  const context = canvas.getContext('2d', { alpha: true })
  const logo = document.querySelector('#logo')
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  if (context === null) { document.body.classList.add('static'); return () => {} }

  const tau = Math.PI * 2
  const colors = ['#65dfff', '#829cff', '#b6a0ff', '#e0f5ff']
  const glows = colors.map(color => {
    const sprite = document.createElement('canvas')
    sprite.width = sprite.height = 32
    const brush = sprite.getContext('2d')
    const glow = brush.createRadialGradient(16, 16, 0, 16, 16, 16)
    glow.addColorStop(0, '#ffffff')
    glow.addColorStop(.12, color)
    glow.addColorStop(.35, `${color}66`)
    glow.addColorStop(1, `${color}00`)
    brush.fillStyle = glow
    brush.fillRect(0, 0, 32, 32)
    return sprite
  })
  const pointer = { x: 0, y: 0, active: false, tiltX: 0, tiltY: 0 }
  const trails = []
  const bursts = []
  let particles = []
  let frame = 0
  let disposed = false
  let width = 0
  let height = 0
  let centerX = 0
  let centerY = 0
  let logoWidth = 0
  let logoHeight = 0
  let time = 0
  let lastFrame = 0

  function particle(kind, index, homeX = 0, homeY = 0) {
    const angle = kind === 'orbit' ? index % 3 * tau / 3 + (Math.random() - .5) * .5 : Math.random() * tau
    const radius = .18 + Math.random() ** .65 * .82
    return { kind, homeX, homeY, angle, radius, phase: Math.random() * tau,
      x: 0, y: 0, offsetX: 0, offsetY: 0,
      vx: 0, vy: 0, size: .45 + Math.random() * (kind === 'logo' ? .8 : 1.1),
      color: kind === 'logo' ? (index % 5 === 0 ? 3 : index % 2) : index % colors.length,
      glow: index % (kind === 'logo' ? 13 : 9) === 0 }
  }

  function resize() {
    width = innerWidth
    height = innerHeight
    const ratio = Math.min(devicePixelRatio || 1, 1.5)
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    const rect = document.querySelector('.logo-stage').getBoundingClientRect()
    const logoRect = logo.getBoundingClientRect()
    centerX = rect.left + rect.width / 2
    centerY = rect.top + rect.height / 2
    logoWidth = logoRect.width
    logoHeight = logoRect.height
    particles = []
    // Fixed upper bounds keep dense scenes independent of screen resolution.
    for (let i = 0; i < 720; i += 1) particles.push(particle('star', i, Math.random(), Math.random()))
    for (let i = 0; i < 1600; i += 1) particles.push(particle('orbit', i))
    if (!logo.complete || logo.naturalWidth === 0) return
    const sample = document.createElement('canvas')
    sample.width = 240
    sample.height = 208
    const brush = sample.getContext('2d', { willReadFrequently: true })
    if (brush === null) return
    brush.drawImage(logo, 0, 0, sample.width, sample.height)
    const pixels = brush.getImageData(0, 0, sample.width, sample.height).data
    for (let y = 0; y < sample.height; y += 3) {
      for (let x = 0; x < sample.width; x += 3) {
        if (pixels[(y * sample.width + x) * 4 + 3] < 100) continue
        const point = particle('logo', particles.length, x / sample.width - .5, y / sample.height - .5)
        point.edge = [[-3, 0], [3, 0], [0, -3], [0, 3]].some(([dx, dy]) => {
          const px = x + dx
          const py = y + dy
          return px < 0 || px >= sample.width || py < 0 || py >= sample.height || pixels[(py * sample.width + px) * 4 + 3] < 100
        })
        particles.push(point)
      }
    }
  }

  function spark(x, y, vx, vy, lifetime, index) {
    return { x, y, vx, vy, age: 0, lifetime, phase: Math.random() * tau,
      size: .5 + Math.random(), color: index % colors.length, glow: index % 13 === 0 }
  }

  function move(event) {
    if (reduced.matches || disposed || document.hidden) return
    const fromX = pointer.active ? pointer.x : event.clientX
    const fromY = pointer.active ? pointer.y : event.clientY
    const dx = event.clientX - fromX
    const dy = event.clientY - fromY
    const distance = Math.hypot(dx, dy)
    const count = Math.min(120, Math.ceil(distance / 2) * 3)
    for (let index = 0; index < count; index += 1) {
      const along = index / count
      const angle = Math.random() * tau
      const spread = Math.random() * 5
      trails.push(spark(fromX + dx * along + Math.cos(angle) * spread,
        fromY + dy * along + Math.sin(angle) * spread,
        Math.cos(angle) * .65 + dx / distance * .3,
        Math.sin(angle) * .65 + dy / distance * .3, .7 + Math.random() * .65, index))
    }
    if (trails.length > 760) trails.splice(0, trails.length - 760)
    pointer.x = event.clientX
    pointer.y = event.clientY
    pointer.active = true
  }
  function leave() { pointer.active = false }
  function burst(event) {
    if (reduced.matches || disposed || document.hidden || event.button !== 0 || event.clientY < 34) return
    move(event)
    for (let index = 0; index < 680; index += 1) {
      const angle = Math.random() * tau
      const radius = Math.random() * 14
      const speed = 1.2 + Math.random() ** .65 * 6
      bursts.push(spark(pointer.x + Math.cos(angle) * radius, pointer.y + Math.sin(angle) * radius,
        Math.cos(angle) * speed, Math.sin(angle) * speed, 1 + Math.random() * .7, index))
    }
    if (bursts.length > 1360) bursts.splice(0, bursts.length - 1360)
    for (const p of particles) {
      const dx = p.x - pointer.x
      const dy = p.y - pointer.y
      const distance = Math.max(1, Math.hypot(dx, dy))
      const force = 14 * Math.exp(-distance / 200)
      p.vx += dx / distance * force
      p.vy += dy / distance * force
    }
  }

  function paint(p, alpha, glowScale) {
    context.globalAlpha = alpha
    context.fillStyle = colors[p.color]
    context.fillRect(p.x, p.y, p.size, p.size)
    if (p.glow) {
      const size = p.size * glowScale
      context.drawImage(glows[p.color], p.x - size / 2, p.y - size / 2, size, size)
    }
  }

  function drift(sparks, dt, curl) {
    for (let index = sparks.length - 1; index >= 0; index -= 1) {
      const p = sparks[index]
      p.age += dt / 60
      if (p.age >= p.lifetime) { sparks.splice(index, 1); continue }
      const angle = curl * dt
      const vx = p.vx * Math.cos(angle) - p.vy * Math.sin(angle)
      p.vy = (p.vx * Math.sin(angle) + p.vy * Math.cos(angle)) * Math.pow(.985, dt)
      p.vx = vx * Math.pow(.985, dt)
      p.x += p.vx * dt
      p.y += p.vy * dt
      const fade = (1 - p.age / p.lifetime) ** 1.3
      paint(p, fade * (.65 + Math.sin(p.phase + p.age * 9) * .25), 6)
    }
  }

  function draw(now) {
    frame = 0
    if (disposed || document.hidden || reduced.matches) return
    frame = requestAnimationFrame(draw)
    if (lastFrame !== 0 && now - lastFrame < 1000 / 60 - 1) return
    const dt = Math.min(lastFrame === 0 ? 1 : (now - lastFrame) / (1000 / 60), 2)
    lastFrame = now
    time += dt / 60
    const entrance = Math.min(1, time / .4)
    const unfurl = 1 - (1 - Math.min(1, Math.max(0, (time - .35) / 1.25))) ** 3
    const tiltX = pointer.active ? (pointer.x / width - .5) * 2 : 0
    const tiltY = pointer.active ? (pointer.y / height - .5) * 2 : 0
    pointer.tiltX += (tiltX - pointer.tiltX) * .06 * dt
    pointer.tiltY += (tiltY - pointer.tiltY) * .06 * dt
    document.documentElement.style.setProperty('--parallax-x', `${pointer.tiltX * 7}px`)
    document.documentElement.style.setProperty('--parallax-y', `${pointer.tiltY * 5}px`)
    context.clearRect(0, 0, width, height)
    context.globalCompositeOperation = 'lighter'
    const orbitSize = Math.min(width * .44, 330)
    const flatten = .4 + pointer.tiltY * .09
    const rotation = -.2 + Math.sin(time * .15) * .06 + pointer.tiltX * .1
    const cos = Math.cos(rotation)
    const sin = Math.sin(rotation)

    for (const p of particles) {
      let x
      let y
      let alpha
      let shimmer = 0
      if (p.kind === 'logo') {
        x = centerX + p.homeX * logoWidth + pointer.tiltX * 7 + Math.sin(time * 1.6 + p.homeY * 10) * 1.2
        y = centerY + p.homeY * logoHeight + pointer.tiltY * 5 + Math.cos(time * 1.4 + p.homeX * 8) * 1.2
        const sweep = (time - .25) / 1.05 * 1.55 - .8
        const position = p.homeX - p.homeY * .3
        const lit = Math.min(1, Math.max(0, (sweep - position) / .16))
        const outline = p.edge ? Math.sin(Math.min(1, time / 1.4) * Math.PI) * .55 : 0
        shimmer = Math.exp(-((position - sweep) ** 2) / .009) * .8
        alpha = .025 + outline + lit * (.5 + Math.sin(time * 2 + p.phase) * .18) + shimmer
      } else if (p.kind === 'orbit') {
        const angle = p.angle + p.radius * 5.5 + (1 - unfurl) * .8 + time * (.08 + (1 - p.radius) * .14)
        const radius = orbitSize * (.42 + p.radius * .58) * (.7 + unfurl * .3)
        const px = Math.cos(angle) * radius
        const py = Math.sin(angle) * radius * flatten
        x = centerX + px * cos - py * sin + pointer.tiltX * 15
        y = centerY + px * sin + py * cos + Math.sin(p.phase + time * .5) * 9 + pointer.tiltY * 9
        alpha = (.14 + (Math.sin(angle) + 1) * .19) * unfurl
      } else {
        x = (p.homeX * width + Math.sin(time * .12 + p.phase) * 18 + width) % width
        y = (p.homeY * height - time * (1 + p.radius * 3) + height * 100) % height
        x += pointer.tiltX * p.radius * 12
        y += pointer.tiltY * p.radius * 8
        alpha = .12 + (Math.sin(time * .8 + p.phase) + 1) * .17
      }
      p.x = x + p.offsetX
      p.y = y + p.offsetY
      p.vx -= p.offsetX * .032 * dt
      p.vy -= p.offsetY * .032 * dt
      if (pointer.active) {
        const dx = p.x - pointer.x
        const dy = p.y - pointer.y
        const distance = Math.max(1, Math.hypot(dx, dy))
        if (distance < 125) {
          const force = (1 - distance / 125) ** 2 * 2.8
          p.vx += (dx - dy * .45) / distance * force * dt
          p.vy += (dy + dx * .45) / distance * force * dt
          alpha = Math.min(1, alpha + force * .24)
        }
      }
      const damping = Math.pow(.84, dt)
      p.vx *= damping
      p.vy *= damping
      p.offsetX += p.vx * dt
      p.offsetY += p.vy * dt
      p.x = x + p.offsetX
      p.y = y + p.offsetY
      paint(p, Math.min(1, alpha) * entrance * (p.y > centerY + logoHeight * .7 ? .48 : 1), p.kind === 'logo' ? 7 + shimmer * 12 : 10)
    }
    drift(trails, dt, .035)
    drift(bursts, dt, .014)
    context.globalAlpha = 1
    context.globalCompositeOperation = 'source-over'
    if (time > 1.6) document.body.classList.add('assembled')
  }

  function schedule() {
    cancelAnimationFrame(frame)
    frame = 0
    lastFrame = 0
    document.body.classList.toggle('static', reduced.matches)
    if (reduced.matches) {
      context.clearRect(0, 0, width, height)
      pointer.active = false
      trails.length = bursts.length = 0
    } else if (!document.hidden && !disposed) frame = requestAnimationFrame(draw)
  }
  function loaded() { resize(); schedule() }
  function failed() { document.body.classList.add('static') }
  logo.addEventListener('load', loaded)
  logo.addEventListener('error', failed)
  addEventListener('resize', resize)
  addEventListener('pointermove', move, { passive: true })
  addEventListener('pointerdown', burst, { passive: true })
  document.documentElement.addEventListener('pointerleave', leave)
  document.addEventListener('visibilitychange', schedule)
  reduced.addEventListener('change', schedule)
  resize()
  schedule()
  return () => {
    if (disposed) return
    disposed = true
    cancelAnimationFrame(frame)
    logo.removeEventListener('load', loaded)
    logo.removeEventListener('error', failed)
    removeEventListener('resize', resize)
    removeEventListener('pointermove', move)
    removeEventListener('pointerdown', burst)
    document.documentElement.removeEventListener('pointerleave', leave)
    document.removeEventListener('visibilitychange', schedule)
    reduced.removeEventListener('change', schedule)
  }
}
