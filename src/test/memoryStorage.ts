// An in-memory `Storage` for tests: Node 25+ defines its own global
// `localStorage` (undefined without --localstorage-file), which hides jsdom's.
// Use with `vi.stubGlobal("localStorage", memoryStorage())`.

export function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, String(value));
    },
  };
}
