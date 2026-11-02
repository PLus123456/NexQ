import { create } from "zustand";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { errorMessage } from "../lib/llm/ipc";
import { getQuestionDetectionSettings, onQuestionDetectionSettingsChanged, setQuestionDetectionSettings } from "../lib/questionDetection/ipc";
import type { QuestionDetectionSettings, QuestionDetectionSettingsView } from "../lib/questionDetection/types";

interface QuestionDetectionState {
  view: QuestionDetectionSettingsView | null;
  error: string | null;
  saving: boolean;
  load: () => Promise<void>;
  applyView: (view: QuestionDetectionSettingsView) => void;
  update: (patch: Partial<QuestionDetectionSettings>) => Promise<void>;
}

let subscription: Promise<UnlistenFn> | null = null;
let loading: Promise<void> | null = null;

export const useQuestionDetectionStore = create<QuestionDetectionState>((set, get) => ({
  view: null,
  error: null,
  saving: false,
  applyView: (view) => {
    if (get().view && view.revision < get().view!.revision) return;
    set({ view, error: null });
  },
  load: () => {
    if (loading) return loading;
    if (!subscription) {
      subscription = onQuestionDetectionSettingsChanged((view) => get().applyView(view));
      subscription.catch((err) => {
        subscription = null;
        set({ error: errorMessage(err) });
      });
    }
    loading = (async () => {
      try {
        get().applyView(await getQuestionDetectionSettings());
      } catch (err) {
        set({ error: errorMessage(err) });
      } finally {
        loading = null;
      }
    })();
    return loading;
  },
  update: async (patch) => {
    const current = get().view;
    if (!current || get().saving) return;
    set({ saving: true });
    try {
      get().applyView(await setQuestionDetectionSettings({ ...current.settings, ...patch }));
    } finally {
      set({ saving: false });
    }
  },
}));

export function resetQuestionDetectionStoreForTests() {
  subscription?.then((unlisten) => unlisten()).catch(() => {});
  subscription = null;
  loading = null;
  useQuestionDetectionStore.setState({ view: null, error: null, saving: false });
}
