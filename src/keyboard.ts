import { NOTE_NAMES } from './pitch'

const WHITE = [0, 2, 4, 5, 7, 9, 11]
const BLACK = [1, 3, 6, 8, 10]
export const KEYBOARD_STEPS: Record<string, number> = {
  a: 0,
  w: 1,
  s: 2,
  e: 3,
  d: 4,
  f: 5,
  t: 6,
  g: 7,
  y: 8,
  h: 9,
  u: 10,
  j: 11,
  k: 12,
}

const STEP_KEYS = Object.fromEntries(
  Object.entries(KEYBOARD_STEPS).map(([key, step]) => [step, key.toUpperCase()]),
)

export function renderKeyboard(
  container: HTMLElement,
  startMidi = 48,
  endMidi = 84,
  playableBaseMidi = 60,
): void {
  container.replaceChildren()
  container.classList.add('keyboard')

  const whites: HTMLButtonElement[] = []
  const blacks: HTMLButtonElement[] = []

  for (let midi = startMidi; midi <= endMidi; midi++) {
    const pc = ((midi % 12) + 12) % 12
    const octave = Math.floor(midi / 12) - 1
    const name = NOTE_NAMES[pc]
    const key = document.createElement('button')
    key.type = 'button'
    key.dataset.midi = String(midi)
    key.setAttribute('aria-label', `${name}${octave}`)
    key.tabIndex = 0

    const computerKey = STEP_KEYS[midi - playableBaseMidi]
    if (computerKey) {
      const shortcut = document.createElement('span')
      shortcut.className = 'shortcut-label'
      shortcut.textContent = computerKey
      key.append(shortcut)
    }

    if (WHITE.includes(pc)) {
      key.className = 'key white'
      if (pc === 0) {
        const label = document.createElement('span')
        label.className = 'key-label'
        label.textContent = `C${octave}`
        key.append(label)
      }
      whites.push(key)
    } else if (BLACK.includes(pc)) {
      key.className = 'key black'
      blacks.push(key)
    }
  }

  const whiteRow = document.createElement('div')
  whiteRow.className = 'keys-white'
  whiteRow.append(...whites)

  // Each white key occupies 1/whites.length of the row, so seams and key widths
  // are simple fractions of it. A black key is a little under two thirds of a
  // white key, like an acoustic piano.
  const whiteFraction = whites.length > 0 ? 100 / whites.length : 0
  container.style.setProperty('--black-key-width', `${whiteFraction * 0.62}%`)

  const blackRow = document.createElement('div')
  blackRow.className = 'keys-black'
  let whiteIndex = 0
  for (let midi = startMidi; midi <= endMidi; midi++) {
    const pc = ((midi % 12) + 12) % 12
    if (WHITE.includes(pc)) {
      whiteIndex++
      continue
    }
    if (!BLACK.includes(pc)) continue
    const key = blacks.shift()
    if (!key) continue
    // Centred (via translateX) on the seam after the white key just passed.
    key.style.left = `${whiteIndex * whiteFraction}%`
    blackRow.append(key)
  }

  container.append(whiteRow, blackRow)
}

export function setKeyState(
  container: HTMLElement,
  midi: number,
  state: 'detected' | 'played' | 'target',
  active: boolean,
): void {
  const key = container.querySelector(`.key[data-midi="${Math.round(midi)}"]`)
  key?.classList.toggle(state, active)
}

export function highlightDetectedKey(container: HTMLElement, midi: number | null): void {
  container.querySelectorAll('.key.detected').forEach((el) => {
    el.classList.remove('detected')
  })
  if (midi != null) setKeyState(container, midi, 'detected', true)
}
