// Pseudo-localization operates on catalog text only, before interpolation.
// Braced arguments (including nested ICU constructs) and product brands remain
// byte-for-byte intact; content supplied by users is never passed here.
const brands = /^(?:Free2Z|Zcash|2Z|ZEC)\b/;
/** @type {Record<string, string>} */
const accents = {
  a: "á",
  e: "ë",
  i: "ï",
  o: "ô",
  u: "ü",
  A: "Á",
  E: "Ë",
  I: "Ï",
  O: "Ô",
  U: "Ü",
};
/** @param {string} value @param {"expand" | "accent" | "rtl"} mode */
export function pseudoMessage(value, mode) {
  let result = "",
    depth = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === "{") {
      depth++;
      result += char;
      continue;
    }
    if (char === "}" && depth) {
      depth--;
      result += char;
      continue;
    }
    if (depth) {
      result += char;
      continue;
    }
    const brand = value.slice(i).match(brands);
    if (brand) {
      result += brand[0];
      i += brand[0].length - 1;
      continue;
    }
    if (mode === "rtl" && /[A-Za-z]/.test(char)) {
      const alphabet = "אבגדהוזחטיכלמנסעפצקרשתאבגד";
      result +=
        alphabet[(char.toLowerCase().charCodeAt(0) - 97) % alphabet.length];
    } else {
      result += mode === "accent" ? (accents[char] ?? char) : char;
    }
    if (mode === "expand" && /[aeiouAEIOU]/.test(char)) result += char;
  }
  return mode === "rtl" ? `⟦${result}⟧` : `[${result}]`;
}
/** @param {unknown} catalog @param {"expand" | "accent" | "rtl"} mode @returns {unknown} */
export function pseudoCatalog(catalog, mode) {
  if (typeof catalog === "string") return pseudoMessage(catalog, mode);
  if (Array.isArray(catalog))
    return catalog.map((value) => pseudoCatalog(value, mode));
  if (catalog && typeof catalog === "object")
    return Object.fromEntries(
      Object.entries(catalog).map(([key, value]) => [
        key,
        pseudoCatalog(value, mode),
      ]),
    );
  return catalog;
}
