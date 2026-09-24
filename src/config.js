// Settings window renderer. Shows the config keys, sends back what was typed;
// main.js decides whether it is acceptable and tells us what to say.

const form = document.getElementById('form')
const saveBtn = document.getElementById('save-btn')
const cancelBtn = document.getElementById('cancel-btn')
const formError = document.getElementById('form-error')

// Outside `fields`: a checkbox has no error line because it cannot be invalid.
const expandAll = {
  input: document.getElementById('expand-all'),
  label: document.getElementById('expand-all-label'),
  hint: document.getElementById('expand-all-hint'),
}

const notify = {
  input: document.getElementById('notify'),
  label: document.getElementById('notify-label'),
  hint: document.getElementById('notify-hint'),
}

const notifySound = {
  input: document.getElementById('notify-sound'),
  label: document.getElementById('notify-sound-label'),
  hint: document.getElementById('notify-sound-hint'),
}

const fields = {
  endpoint: {
    input: document.getElementById('endpoint'),
    label: document.getElementById('endpoint-label'),
    hint: document.getElementById('endpoint-hint'),
    error: document.getElementById('endpoint-error'),
  },
  intervalMinutes: {
    input: document.getElementById('interval'),
    label: document.getElementById('interval-label'),
    hint: document.getElementById('interval-hint'),
    error: document.getElementById('interval-error'),
  },
  outputPath: {
    input: document.getElementById('output-path'),
    label: document.getElementById('output-path-label'),
    hint: document.getElementById('output-path-hint'),
    error: document.getElementById('output-path-error'),
  },
}

function reportHeight() {
  // The window is sized to the form, so it fits whichever language is shown.
  // Measured at once, like the panel: offsetHeight forces the layout, and the
  // window stays throttled, as Chromium throttles any hidden page.
  window.settings.reportHeight(document.documentElement.offsetHeight)
}

function showProblems(problems) {
  for (const [key, field] of Object.entries(fields)) {
    const message = problems[key] || ''
    field.error.textContent = message
    field.error.hidden = !message
    field.input.classList.toggle('invalid', Boolean(message))
  }
  formError.textContent = problems.form || ''
  formError.hidden = !problems.form
  reportHeight()
}

function values() {
  return {
    endpoint: fields.endpoint.input.value,
    intervalMinutes: fields.intervalMinutes.input.value,
    outputPath: fields.outputPath.input.value,
    expandAll: expandAll.input.checked,
    notify: notify.input.checked,
    notifySound: notifySound.input.checked,
  }
}

window.settings.load().then(({ config, labels }) => {
  fields.endpoint.label.textContent = labels.endpoint
  fields.endpoint.hint.textContent = labels.endpointHint
  fields.intervalMinutes.label.textContent = labels.interval
  fields.intervalMinutes.hint.textContent = labels.intervalHint
  fields.outputPath.label.textContent = labels.outputPath
  fields.outputPath.hint.textContent = labels.outputPathHint
  expandAll.label.textContent = labels.expandAll
  expandAll.hint.textContent = labels.expandAllHint
  notify.label.textContent = labels.notify
  notify.hint.textContent = labels.notifyHint
  notifySound.label.textContent = labels.notifySound
  notifySound.hint.textContent = labels.notifySoundHint
  saveBtn.textContent = labels.save
  cancelBtn.textContent = labels.cancel

  fields.endpoint.input.value = config.endpoint
  fields.intervalMinutes.input.value = config.intervalMinutes
  fields.outputPath.input.value = config.outputPath
  expandAll.input.checked = config.expandAll
  notify.input.checked = config.notify
  notifySound.input.checked = config.notifySound
  // The sound belongs to the notification: muting something that never fires
  // is a control that lies about what it does.
  syncSoundAvailability()

  reportHeight()
  fields.endpoint.input.focus()
})

/** No notification, no sound to choose. */
function syncSoundAvailability() {
  notifySound.input.disabled = !notify.input.checked
  notifySound.label.classList.toggle('disabled', !notify.input.checked)
}

notify.input.addEventListener('change', syncSoundAvailability)

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  saveBtn.disabled = true
  try {
    const result = await window.settings.save(values())
    if (result && result.ok) {
      window.settings.close()
      return
    }
    showProblems((result && result.problems) || {})
  } finally {
    saveBtn.disabled = false
  }
})

cancelBtn.addEventListener('click', () => window.settings.close())

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.settings.close()
})
