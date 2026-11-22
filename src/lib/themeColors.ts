/**
 * The text colours NexQ ships as defaults were picked for the dark theme:
 * light grey answers and transcript, amber translations. Left at those
 * defaults they follow the theme instead, so the text stays readable on a
 * light background. A colour the user picked is used as it is.
 */
const FOLLOW_THEME: Readonly<Record<string, string>> = {
  "#d4d4d8": "hsl(var(--foreground) / 0.88)", // AI answers
  "#e4e4e7": "hsl(var(--foreground))", // transcript
  "#fbbf24": "hsl(var(--translation-text))", // translations
};

/** The CSS colour to draw `stored` with (a default follows the theme). */
export function textColor(stored: string | null | undefined, fallback: string): string {
  const color = (stored || fallback).toLowerCase();
  return FOLLOW_THEME[color] ?? stored ?? fallback;
}
