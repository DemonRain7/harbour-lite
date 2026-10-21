/** Share bounded infrastructure startup, never a caller's cancellation signal.
 * Canceling a Browser run only stops that run waiting. The daemon/profile check
 * may finish for other callers (or the next run); it cannot submit a page action.
 */
export async function awaitOpenCliStartup(
  flights: Map<string, Promise<void>>, key: string, start: () => Promise<void>, signal?: AbortSignal,
): Promise<void> {
  const stopped = () => new Error("OpenCLI 启动等待已停止");
  if (signal?.aborted) throw stopped();
  let flight = flights.get(key);
  if (!flight) {
    flight = Promise.resolve().then(start);
    flights.set(key, flight);
    const current = flight;
    void flight.finally(() => {
      if (flights.get(key) === current) flights.delete(key);
    }).catch(() => undefined);
  }
  if (!signal) return flight;
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      signal.removeEventListener("abort", abort);
      if (error !== undefined) reject(error); else resolve();
    };
    const abort = () => finish(stopped());
    signal.addEventListener("abort", abort, { once: true });
    void flight.then(() => finish(), error => finish(error));
    if (signal.aborted) abort();
  });
}
