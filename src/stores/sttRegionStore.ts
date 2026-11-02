// NexQ Plus: the Soniox region each party's session is connected to, kept by
// useSTTStatus from `stt_connection_status` (its `region`) and
// `soniox_region_switch`. Every window keeps its own copy (the events reach
// both); the footer's STT chips show it in their tooltips. Cleared when the
// meeting ends.

import { create } from "zustand";

interface SttRegionState {
  /** Party as the backend names it ("You" / "Them") → "us" | "eu" | "jp" | "in" | "custom". */
  regions: Readonly<Record<string, string>>;
  /** `region` null: the party has no Soniox connection any more. */
  setRegion: (party: string, region: string | null) => void;
  clear: () => void;
}

export const useSttRegionStore = create<SttRegionState>((set) => ({
  regions: {},
  setRegion: (party, region) =>
    set((state) => {
      if ((state.regions[party] ?? null) === region) return state;
      const regions = { ...state.regions };
      if (region) regions[party] = region;
      else delete regions[party];
      return { regions };
    }),
  clear: () => set({ regions: {} }),
}));
