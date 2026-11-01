// First-run / quick setup for speech recognition (STT package). Placeholder
// until that package delivers it.

import { QuickSetupPlaceholder } from "../QuickSetupPlaceholder";
import type { QuickSetupProps } from "../quickSetup";

export function SttQuickSetup(props: QuickSetupProps) {
  return <QuickSetupPlaceholder {...props} area="stt" settingsTab="stt" />;
}
