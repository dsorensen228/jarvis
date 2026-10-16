/** One request at a time; teardown suppresses late frames, errors and refreshes. */
export function pollCamera<T>(
  load: () => Promise<T>,
  onValue: (value: T) => void,
  onError: (error: unknown) => void,
  delay: (value: T) => number,
  retryMs = 2000,
): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    let wait = retryMs;
    try {
      const value = await load();
      if (cancelled) return;
      onValue(value);
      wait = delay(value);
    } catch (error) {
      if (cancelled) return;
      onError(error);
    }
    if (!cancelled) timer = setTimeout(() => void tick(), wait);
  };
  void tick();
  return () => { cancelled = true; clearTimeout(timer); };
}
