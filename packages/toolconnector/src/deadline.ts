/**
 * Bounded-wait helper for boot-time network resolution.
 *
 * Returns the promise's value when it settles before the deadline; returns
 * `null` when the deadline passes first. The underlying promise is NOT
 * cancelled — its side effects (search-config cache persistence,
 * logout-on-invalid-key) still complete in the background; only the awaited
 * result is dropped so boot can proceed deterministically.
 */
export async function withDeadline<T>(
  promise: Promise<T>,
  deadlineEpochMs: number,
): Promise<T | null> {
  const remaining = deadlineEpochMs - Date.now();
  if (remaining <= 0) return null;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
