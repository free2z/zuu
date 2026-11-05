/** Select a process-owned generated tree for Node and browser test servers.
 * @param {NodeJS.ProcessEnv} env
 * @param {number} pid
 * @returns {string | undefined}
 */
export function testViteOutput(env, pid) {
  if (env.NODE_TEST_CONTEXT) return `.svelte-kit-test-${pid}`;
  if (env.FREE2Z_BROWSER_TEST !== "1") return undefined;
  const named = env.FREE2Z_BROWSER_OUTPUT_NAME;
  if (!named) return `.svelte-kit-test-${pid}`;
  if (!/^\.svelte-kit-test-browser-\d+$/.test(named))
    throw new Error("Invalid browser generated-output name");
  return named;
}
