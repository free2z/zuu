/**
 * Append a page without replacing existing item objects. Keeping those objects
 * stable lets keyed media cards retain their DOM and interaction state while a
 * new page is added. IDs are de-duplicated in case uploads shift page
 * boundaries between requests.
 *
 * @template {{ id: number }} T
 * @param {readonly T[]} currentItems
 * @param {readonly T[]} nextItems
 * @returns {T[]}
 */
export function appendMediaPage(currentItems, nextItems) {
  const knownIds = new Set(currentItems.map((item) => item.id));
  const uniqueNextItems = nextItems.filter((item) => {
    if (knownIds.has(item.id)) {
      return false;
    }

    knownIds.add(item.id);
    return true;
  });

  return [...currentItems, ...uniqueNextItems];
}
