/**
 * Latin words (2+ letters) in the text and in the title / aria-label / alt /
 * placeholder attributes under `root` that aren't in `keep`. A Chinese page
 * should have none besides product and technical names.
 */
export function untranslatedWords(root: HTMLElement, keep: readonly string[] = []): string[] {
  const texts: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) texts.push(walker.currentNode.textContent ?? "");
  root.querySelectorAll("*").forEach((el) => {
    for (const attr of ["title", "aria-label", "alt", "placeholder"]) {
      const value = el.getAttribute(attr);
      if (value) texts.push(value);
    }
  });
  return texts.flatMap((text) => text.match(/[A-Za-z]{2,}/g) ?? []).filter((w) => !keep.includes(w));
}
