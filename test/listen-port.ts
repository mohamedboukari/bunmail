/**
 * Ports of the listeners the tests start (#443).
 *
 * Every test listener binds port `0`: the OS picks a free port from its
 * ephemeral range (macOS 49152 to 65535, Linux 32768 to 60999 by default),
 * and the test reads the real port back from the server. No two runs on
 * one machine can then collide on a port (EADDRINUSE), so two integration
 * suites against two databases can run at the same time.
 *
 * `test/unit/test-listener-ports.test.ts` fails on a hard-coded listener
 * port, so a fixed port cannot come back.
 */

/**
 * The lowest port a test listener may end up on. System and well-known
 * ports (below 1024) and the low ports local services use (3000, 5432,
 * 8080, ...) stay untouched; an OS ephemeral range always starts above it.
 */
export const MIN_TEST_PORT = 10_000;

/**
 * Checks the port a test listener bound with port `0` and returns it.
 *
 * @param bound - The port read back from the server (`server.address().port`,
 *                `server.port`), or a promise of it (a service's
 *                `listeningPort()`)
 * @param label - Which listener it is, for the error message
 * @returns The bound port, once it is known
 * @throws When the port is below `MIN_TEST_PORT` (a hard-coded or system
 *         port, or a server that did not report one)
 */
export async function boundTestPort(
  bound: number | Promise<number>,
  label: string,
): Promise<number> {
  const port = await bound;
  if (!Number.isInteger(port) || port < MIN_TEST_PORT || port > 65_535) {
    throw new Error(
      `${label} is listening on port ${port}: test listeners must bind port 0 so the ` +
        `OS picks a free ephemeral port (>= ${MIN_TEST_PORT}), never a fixed or system port (#443).`,
    );
  }
  return port;
}
