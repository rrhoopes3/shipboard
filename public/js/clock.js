// The board's notion of "now". Ages, elapsed job time, leases and "runner online" all compare
// server timestamps, so they use the server clock (from the Date header), not the browser's.

let offset = 0

export function now() {
  return Date.now() + offset
}

/** Adopts the server clock when it disagrees with ours by more than the Date header's resolution. */
export function noteServerDate(header) {
  const at = header ? Date.parse(header) : NaN
  if (!Number.isFinite(at)) return
  const delta = at + 500 - Date.now()
  offset = Math.abs(delta) > 2000 ? delta : 0
}

/** Fixture mode pins the clock to the moment the fixture describes, then lets it run. */
export function setNow(iso) {
  const at = Date.parse(iso)
  if (Number.isFinite(at)) offset = at - Date.now()
}
