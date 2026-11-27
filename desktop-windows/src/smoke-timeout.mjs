/** Run a smoke-test operation with a hard upper bound and an optional timeout signal. */
export async function withSmokeTimeout(operation, timeoutMs, onTimeout = () => {}) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(Error('Smoke operation timed out.'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
