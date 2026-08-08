const started = performance.now()

export function progress(message: string, details?: Record<string, unknown>) {
  const elapsed = ((performance.now() - started) / 1_000).toFixed(1)
  const suffix = details ? ` ${JSON.stringify(details)}` : ""
  console.error(`[desktop-profile +${elapsed}s] ${message}${suffix}`)
}
