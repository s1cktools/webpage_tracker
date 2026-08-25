class ScanTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`website scan timed out after ${timeoutMs}ms`);
    this.name = "ScanTimeoutError";
  }
}

async function runWithScanTimeout(task, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new ScanTimeoutError(timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([task(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { ScanTimeoutError, runWithScanTimeout };
