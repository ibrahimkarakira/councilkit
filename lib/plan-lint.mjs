// Plan structure check: review findings anchor to these sections, so every plan must have them.
export const PLAN_SECTIONS = Object.freeze(['Goal', 'Acceptance', 'Non-goals', 'Files', 'Test plan']);

// Returns the required `## ` headings the plan lacks, in PLAN_SECTIONS order (empty = ok).
// Headings inside ``` or ~~~ fenced blocks do not count.
export function missingSections(text) {
  const found = new Set();
  let fence = null;
  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) {
      fence = fence ? null : marker;
    } else if (!fence) {
      const heading = line.match(/^## +(.+?)[ \t#]*$/)?.[1];
      if (heading) found.add(heading);
    }
  }
  return PLAN_SECTIONS.filter((name) => !found.has(name));
}
