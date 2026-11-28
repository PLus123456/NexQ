import { useEffect, useState } from "react";
import { getApiKey, storeApiKey } from "../../lib/ipc";
import { storeMicrosoftTranslationCredentials } from "../../lib/translation/ipc";
import { MICROSOFT_REGION_KEY, type ProviderOption } from "./providers";

interface CredentialDraft {
  slot: string;
  apiKey: string;
  hasStoredKey: boolean;
  keyDirty: boolean;
  region: string;
  regionDirty: boolean;
  loaded: boolean;
}

function emptyDraft(slot: string): CredentialDraft {
  return { slot, apiKey: "", hasStoredKey: false, keyDirty: false, region: "global", regionDirty: false, loaded: !slot };
}

export function useTranslationCredentialDraft(option: ProviderOption | undefined) {
  const slot = option?.credentialKey ?? "";
  const needsRegion = option?.needsRegion ?? false;
  const [draft, setDraft] = useState(() => emptyDraft(slot));

  useEffect(() => {
    let cancelled = false;
    setDraft(emptyDraft(slot));
    if (!slot) return;

    void Promise.allSettled([
      getApiKey(slot),
      needsRegion ? getApiKey(MICROSOFT_REGION_KEY) : Promise.resolve(null),
    ]).then(([keyRead, regionRead]) => {
      if (cancelled) return;
      const key = keyRead.status === "fulfilled" ? keyRead.value?.trim() ?? "" : "";
      const region = regionRead.status === "fulfilled" ? regionRead.value?.trim() || "global" : "global";
      setDraft((current) => ({
        ...current,
        hasStoredKey: Boolean(key),
        apiKey: current.keyDirty ? current.apiKey : key,
        region: current.regionDirty ? current.region : region,
        loaded: true,
      }));
    });
    return () => { cancelled = true; };
  }, [slot, needsRegion]);

  const update = (patch: Partial<Omit<CredentialDraft, "slot">>) => {
    setDraft((current) => ({ ...(current.slot === slot ? current : emptyDraft(slot)), ...patch }));
  };
  return { ...(draft.slot === slot ? draft : emptyDraft(slot)), update };
}

/** Persist the credential fields that just passed a connection test. */
export async function saveTestedTranslationCredentials(
  option: ProviderOption,
  apiKey: string | undefined,
  region: string | undefined,
): Promise<void> {
  if (option.needsRegion && apiKey && region) {
    await storeMicrosoftTranslationCredentials(apiKey, region);
  } else if (apiKey) {
    await storeApiKey(option.credentialKey, apiKey);
  } else if (option.needsRegion && region) {
    await storeApiKey(MICROSOFT_REGION_KEY, region);
  }
}
