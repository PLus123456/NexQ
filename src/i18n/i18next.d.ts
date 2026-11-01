// Type-checked translation keys: `t("settings:about.title")` fails `tsc` when
// the key is missing from the English resources.

import "i18next";
import type { DEFAULT_NS, en } from "./resources";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: typeof DEFAULT_NS;
    resources: typeof en;
    returnNull: false;
  }
}
