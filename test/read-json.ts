/**
 * Parse a Response body as JSON, typed for the test that reads it.
 *
 * `Response.json()` is `Promise<any>` in bun-types. Casting at every call
 * site scatters `as` through the suite; routing through here keeps the one
 * unavoidable assertion at the JSON boundary. The assertions that follow in
 * each test are what actually verify the shape.
 */
export async function readJson<T>(response: Response): Promise<T> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return (await response.json()) as T;
}
