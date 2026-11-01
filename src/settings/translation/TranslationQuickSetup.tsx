// First-run / quick setup for translation (translation package). Placeholder
// until that package delivers it.

import { QuickSetupPlaceholder } from "../QuickSetupPlaceholder";
import type { QuickSetupProps } from "../quickSetup";

export function TranslationQuickSetup(props: QuickSetupProps) {
  return <QuickSetupPlaceholder {...props} area="translation" settingsTab="translation" />;
}
