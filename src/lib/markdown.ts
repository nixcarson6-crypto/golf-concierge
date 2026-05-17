/**
 * Tiny safe markdown renderer for chat bubbles.
 *
 * Why custom: we only want a small subset (bold, italic, bullet/numbered
 * lists, inline code) and we want zero dependencies for a 1KB output. Heavy
 * markdown libraries are overkill and add a lot to the bundle. This escapes
 * all HTML first so user-supplied strings can't smuggle markup.
 */

export function renderInlineMarkdown(input: string): string {
  let text = escapeHtml(input);
  // Inline code: `…`
  text = text.replace(
    /`([^`\n]+?)`/g,
    '<code class="px-1 py-0.5 rounded bg-surface-raised text-[hsl(var(--navy))] text-[0.85em]">$1</code>',
  );
  // Bold: **…**
  text = text.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
  // Italic: *…*
  text = text.replace(/(^|[\s(])\*([^*\n]+?)\*(?=[\s).,!?]|$)/g, "$1<em>$2</em>");
  return text;
}

export function renderMarkdownBlock(input: string): string {
  const lines = input.split("\n");
  const out: string[] = [];
  let listType: "ul" | "ol" | null = null;

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/g, "");
    const bullet = /^\s*[-•·*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet) {
      if (listType !== "ul") {
        closeList();
        out.push('<ul class="mt-1 mb-1 pl-4 list-disc space-y-0.5">');
        listType = "ul";
      }
      out.push(`<li>${renderInlineMarkdown(bullet[1])}</li>`);
      continue;
    }
    if (numbered) {
      if (listType !== "ol") {
        closeList();
        out.push('<ol class="mt-1 mb-1 pl-5 list-decimal space-y-0.5">');
        listType = "ol";
      }
      out.push(`<li>${renderInlineMarkdown(numbered[1])}</li>`);
      continue;
    }
    closeList();
    if (line.trim() === "") {
      out.push("<br/>");
    } else {
      out.push(renderInlineMarkdown(line));
      out.push("<br/>");
    }
  }
  closeList();
  // Trim trailing <br/>s
  while (out[out.length - 1] === "<br/>") out.pop();
  return out.join("");
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
