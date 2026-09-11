const api = window.dshDesktop

const PHASE_MESSAGE = {
  verifying: 'setupVerifying',
  store: 'setupStore',
  installing: 'setupInstalling',
  health: 'setupHealth',
  activating: 'setupActivating',
  starting: 'setupStarting',
}

async function main() {
  const locale = await api.locale()
  const messages = locale.messages
  document.documentElement.lang = locale.id
  document.querySelector('#page-title').textContent = messages.setupWindowTitle
  document.querySelector('#title').textContent = messages.setupTitle
  document.querySelector('#description').textContent = messages.setupDescription
  const status = document.querySelector('#status')

  function render(state) {
    const key = PHASE_MESSAGE[state.phase]
    status.textContent = key === undefined ? '' : messages[key]
  }

  api.setup.subscribe(render)
}

void main()
