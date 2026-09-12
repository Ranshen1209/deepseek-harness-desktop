import { startParticles } from './startup-particles.js'

const api = window.dshDesktop

const PHASE_MESSAGE = {
  verifying: 'setupVerifying', store: 'setupStore', installing: 'setupInstalling',
  health: 'setupHealth', activating: 'setupActivating', starting: 'setupStarting', ready: 'setupReady',
}

async function main() {
  const locale = await api.locale()
  const messages = locale.messages
  document.documentElement.lang = locale.id
  for (const [id, key] of Object.entries({ 'page-title': 'setupWindowTitle', title: 'setupTitle',
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
