/**
 * Tiny safe markdown renderer for chat bubbles.
 *
 * Why custom: we only want a small subset (headers, bold, italic, bullet/
 * numbered lists, inline code, links) and we want a tiny output. Heavy
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
  // Links: [text](url). Only http(s) and mailto schemes; everything else
  // falls through as literal text so we can't be tricked into javascript: urls.
  // The URL match excludes whitespace and the closing paren so the regex
  // doesn't run away across lines.
  text = text.replace(
    /\[([^\]\n]+?)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
    (_m, label: string, url: string) =>
      `<a href="${url}" target="_blank" rel="noopener noreferrer" class="text-[hsl(var(--navy))] underline underline-offset-2 hover:text-[hsl(var(--copper))]">${label}</a>`,
  );
  // Bold: **…**
  text = text.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
  // Italic: *…*
  text = text.replace(/(^|[\s(])\*([^*\n]+?)\*(?=[\s).,!?]|$)/g, "$1<em>$2</em>");
  return text;
}

export function renderMarkdownBlock(input: string): string {
  // Pre-process: join markdown links that got split across lines by the model
  // wrapping a long URL ("...[label]\n(https://...)"). Markdown spec requires
  // the URL on the same line, but the streaming model breaks lines liberally.
  const collapsed = input.replace(/\]\s*\n\s*\(/g, "](");

  const lines = collapsed.split("\n");
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

    // Headers — # / ## / ### (with optional trailing #s)
    const header = /^(#{1,3})\s+(.+?)\s*#*$/.exec(line);
    if (header) {
      closeList();
      const level = header[1].length;
      const sizeClass =
        level === 1
          ? "text-lg font-medium mt-2 mb-1"
          : level === 2
            ? "text-[15px] font-medium mt-2 mb-0.5"
            : "text-sm font-medium mt-1.5 mb-0.5";
      out.push(`<h${level} class="${sizeClass}">${renderInlineMarkdown(header[2])}</h${level}>`);
      continue;
    }

    // Horizontal rule
    if (/^\s*---+\s*$/.test(line)) {
      closeList();
      out.push('<hr class="my-2 border-border/60"/>');
      continue;
    }

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
