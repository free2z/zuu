/** Add private revalidation without discarding stricter origin restrictions.
 * @param {string | null} value
 */
export function privateCacheControl(value) {
  const directives = (value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !/^(public|s-maxage|private)(?:\s*=|$)/i.test(part));
  if (!directives.some((part) => /^no-cache(?:\s*=|$)/i.test(part)))
    directives.push("no-cache");
  directives.unshift("private");
  return directives.join(", ");
}
