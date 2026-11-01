import "@testing-library/jest-dom/vitest";
import { initI18n } from "../i18n";

// Tests always run in English (the en resources hold the original UI text).
await initI18n({ language: "en" });
