type Unlisten = () => void;

/** Owns asynchronous event registrations and ignores delivery after disposal. */
export function createEventScope(label: string) {
  let disposed = false;
  const unlisteners: Unlisten[] = [];

  return {
    active: () => !disposed,
    async add<T>(register: (callback: (event: T) => void) => Promise<Unlisten>, callback: (event: T) => void) {
      try {
        const unlisten = await register((event) => {
          if (!disposed) callback(event);
        });
        if (disposed) unlisten();
        else unlisteners.push(unlisten);
        return !disposed;
      } catch (error) {
        if (!disposed) console.warn(`[${label}] Event subscription failed:`, error);
        return false;
      }
    },
    dispose() {
      disposed = true;
      unlisteners.splice(0).forEach((unlisten) => unlisten());
    },
  };
}
