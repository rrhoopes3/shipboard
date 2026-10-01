// Right-hand sheets (dispatch drawer, inspector). One at a time; modal: the rest of the page is
// inert, Tab stays inside, Esc closes, and focus goes back to whatever opened it.

const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, iframe, [tabindex]:not([tabindex='-1'])"

let active = null

function scrim() {
  return document.getElementById("scrim")
}

function setInert(on) {
  for (const id of ["view", "topbar", "skip"]) {
    const el = document.getElementById(id)
    if (el) el.inert = on
  }
}

export function isSheetOpen() {
  return active !== null
}

/** `opener` is where focus returns on close; Safari does not focus buttons on click, so pass it. */
export function openSheet(sheet, { focus, onClose, opener: given } = {}) {
  const previous = active?.opener
  if (active && active.sheet !== sheet) closeSheet({ restore: false })
  const opener = given ?? previous ?? document.activeElement
  active = { sheet, opener, onClose }
  const s = scrim()
  if (s) s.hidden = false
  sheet.hidden = false
  setInert(true)
  requestAnimationFrame(() => {
    s?.classList.add("is-open")
    sheet.classList.add("is-open")
  })
  setTimeout(() => {
    const target = typeof focus === "function" ? focus() : null
    ;(target ?? sheet.querySelector(FOCUSABLE))?.focus({ preventScroll: true })
  }, 40)
}

export function closeSheet({ restore = true } = {}) {
  if (!active) return
  const { sheet, opener, onClose } = active
  active = null
  sheet.classList.remove("is-open")
  sheet.hidden = true
  const s = scrim()
  if (s) {
    s.classList.remove("is-open")
    s.hidden = true
  }
  setInert(false)
  onClose?.()
  if (restore && opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true })
}

/** The element that opened the sheet, when it has been re-rendered under the same data-key. */
export function retarget(el) {
  if (active) active.opener = el
}

export function sheetOpener() {
  return active?.opener ?? null
}

document.addEventListener("keydown", (e) => {
  if (!active) return
  if (e.key === "Escape") {
    // A select or details element inside the sheet handles its own Escape first.
    if (e.defaultPrevented) return
    e.preventDefault()
    e.stopPropagation()
    closeSheet()
    return
  }
  if (e.key !== "Tab") return
  const items = Array.from(active.sheet.querySelectorAll(FOCUSABLE)).filter((el) => el instanceof HTMLElement && el.offsetParent !== null && !el.closest("[hidden]"))
  if (!items.length) return
  const first = items[0]
  const last = items[items.length - 1]
  if (e.shiftKey && (document.activeElement === first || !active.sheet.contains(document.activeElement))) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && (document.activeElement === last || !active.sheet.contains(document.activeElement))) {
    e.preventDefault()
    first.focus()
  }
})

document.addEventListener("click", (e) => {
  if (active && e.target === scrim()) closeSheet()
})
