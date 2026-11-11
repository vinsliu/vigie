/**
 * Stores `value` under `key` in a Map used as a cache, and forgets the oldest entries beyond `max`.
 * Re-setting a key makes it the newest. Keeps a long-running server from growing without bound
 * when files keep appearing under ~/.claude.
 */
export function remember<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}
