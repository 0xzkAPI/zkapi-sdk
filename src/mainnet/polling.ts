/** No background confirmation traffic; the original public identity stays pending. */
export function confirmationPaused(): boolean {
  return (typeof document !== 'undefined' && document.visibilityState === 'hidden') ||
    (typeof navigator !== 'undefined' && navigator.onLine === false);
}

/** Default 2.5s → 5s → 10s cap; explicit slower polling remains slower. */
export function confirmationDelay(baseMs = 2500, attempt = 0): number {
  const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 2500;
  return Math.min(base * 2 ** Math.min(Math.max(attempt, 0), 20), Math.max(base, 10000));
}
