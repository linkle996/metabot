/**
 * Markdown → Feishu Post (rich text) converter.
 *
 * Uses marked.lexer() to parse markdown into tokens, then maps each token to
 * the Feishu Post inline-element structure.  The output is a Post content object
 * ready for JSON.stringify and sending as msg_type: "post".
 */
import { marked, type Tokens } from 'marked';

// ---- Post element types ------------------------------------------------

interface PostText {
  tag: 'text';
  text: string;
  style?: string[];
}

interface PostLink {
  tag: 'a';
  text: string;
  href: string;
}

type PostElement = PostText | PostLink;

type PostParagraph = PostElement[];

interface PostBody {
  title?: string;
  content: PostParagraph[];
}

interface PostContent {
  zh_cn: PostBody;
}

// ---- helpers -----------------------------------------------------------

function textEl(text: string, style?: string[]): PostText {
  const el: PostText = { tag: 'text', text };
  if (style && style.length > 0) el.style = style;
  return el;
}

function linkEl(text: string, href: string): PostLink {
  return { tag: 'a', text, href };
}

/** Flatten a marked inline-token tree into Post elements, merging nested styles. */
function flattenInline(
  tokens: Tokens.Generic[] | undefined,
  inherited: string[] = [],
): PostElement[] {
  if (!tokens) return [];

  const out: PostElement[] = [];

  for (const t of tokens) {
    switch (t.type) {
      case 'text':
        out.push(textEl(t.text, inherited));
        break;
      case 'escape':
        out.push(textEl((t as Tokens.Escape).text, inherited));
        break;
      case 'strong': {
        const merged = [...inherited, 'bold'];
        out.push(...flattenInline((t as Tokens.Strong).tokens, merged));
        break;
      }
      case 'em': {
        const merged = [...inherited, 'italic'];
        out.push(...flattenInline((t as Tokens.Em).tokens, merged));
        break;
      }
      case 'del': {
        const merged = [...inherited, 'strikethrough'];
        out.push(...flattenInline((t as Tokens.Del).tokens, merged));
        break;
      }
      case 'codespan':
        out.push(textEl((t as Tokens.Codespan).text, [...inherited, 'inline_code']));
        break;
      case 'link': {
        const link = t as Tokens.Link;
        const inner = flattenInline(link.tokens, inherited);
        // If the link text has styles, render styled text + link
        if (inner.length > 0) {
          out.push(...inner);
          out.push(textEl(' (', inherited));
          out.push(linkEl(link.text || link.href, link.href));
          out.push(textEl(')', inherited));
        } else {
          out.push(linkEl(link.text || link.href, link.href));
        }
        break;
      }
      case 'image': {
        const img = t as Tokens.Image;
        // Post inline images require a pre-uploaded image_key.
        // Fall back to a text representation.
        out.push(textEl(`[图片: ${img.title || img.text || 'image'}]`, inherited));
        break;
      }
      case 'br':
        // Line break → paragraph break (handled at block level)
        break;
      default:
        // Other inline types → raw text
        if ((t as any).text) out.push(textEl((t as any).text, inherited));
        break;
    }
  }

  return out;
}

// ---- block-level processing -------------------------------------------

function tokenToParagraphs(
  token: Tokens.Generic,
  _allTokens: Tokens.Generic[],
): PostParagraph[] {
  switch (token.type) {
    case 'heading': {
      const t = token as Tokens.Heading;
      // Heading → bold paragraph
      const level = Math.min(6, Math.max(1, t.depth));
      const prefix = '#'.repeat(level) + ' ';
      return [[textEl(prefix + (t.text || ''), ['bold'])]];
    }

    case 'paragraph': {
      const t = token as Tokens.Paragraph;
      const elements = flattenInline(t.tokens);
      if (elements.length === 0) return [];
      return [elements];
    }

    case 'code': {
      const t = token as Tokens.Code;
      // Code block → paragraph with inline_code style
      const lines = t.text.split('\n');
      return lines.map((line) => [textEl(line, ['inline_code'])]);
    }

    case 'list': {
      const t = token as Tokens.List;
      const paras: PostParagraph[] = [];
      let itemNum = t.start || 1;
      for (const item of t.items) {
        const prefix = t.ordered ? `${itemNum++}. ` : '• ';
        // Flatten item tokens and prepend bullet
        if (item.tokens) {
          for (const itemToken of item.tokens) {
            if (itemToken.type === 'text') {
              const text = (itemToken as Tokens.Text).text;
              paras.push([textEl(prefix + text)]);
            } else {
              const inner = tokenToParagraphs(itemToken, _allTokens);
              if (inner.length > 0) {
                // Prepend bullet to first element text
                const firstEl = inner[0][0];
                if (firstEl && firstEl.tag === 'text') {
                  firstEl.text = prefix + firstEl.text;
                }
                paras.push(...inner);
              }
            }
          }
        }
      }
      return paras;
    }

    case 'blockquote': {
      const t = token as Tokens.Blockquote;
      // Render blockquote tokens, prefix each paragraph with "│ "
      const inner: PostParagraph[] = [];
      if (t.tokens) {
        for (const innerToken of t.tokens) {
          inner.push(...tokenToParagraphs(innerToken, _allTokens));
        }
      }
      for (const p of inner) {
        const first = p[0];
        if (first && first.tag === 'text') {
          first.text = '│ ' + first.text;
        }
      }
      return inner;
    }

    case 'table': {
      const t = token as Tokens.Table;
      // Tables have no native Post equivalent → render as plain text grid
      const rows: string[] = [];
      // Header
      rows.push(t.header.map((h) => h.text).join(' | '));
      rows.push(t.header.map(() => '---').join(' | '));
      // Body
      for (const row of t.rows) {
        rows.push(row.map((c) => c.text).join(' | '));
      }
      return rows.map((r) => [textEl(r)]);
    }

    case 'hr':
      // Horizontal rule → 20 dashes as a paragraph
      return [[textEl('─'.repeat(20))]];

    case 'space':
      return [];

    case 'html': {
      // Strip HTML tags, keep text
      const html = token as Tokens.HTML;
      const stripped = (html.text || html.raw || '').replace(/<[^>]*>/g, '');
      if (stripped.trim()) return [[textEl(stripped)]];
      return [];
    }

    default:
      // Unknown blocks → raw text
      if ((token as any).text) {
        return [[textEl((token as any).text)]];
      }
      return [];
  }
}

// ---- public API --------------------------------------------------------

export interface MarkdownToPostOptions {
  /** Title shown at the top of the Post message. */
  title?: string;
}

/**
 * Convert a markdown string to a Feishu Post message content object.
 *
 * Pass the returned object to `JSON.stringify()` and send as `msg_type: "post"`.
 */
export function markdownToPost(
  md: string,
  options?: MarkdownToPostOptions,
): Record<string, unknown> {
  const body: PostBody = {
    content: [],
  };

  if (options?.title) {
    body.title = options.title;
  }

  if (!md) {
    body.content = [[textEl('(empty response)')]];
  } else {
    const tokens = marked.lexer(md);
    const paragraphs: PostParagraph[] = [];

    for (const token of tokens) {
      paragraphs.push(...tokenToParagraphs(token, tokens));
    }

    body.content = paragraphs;
  }

  const result: PostContent = { zh_cn: body };
  return result as unknown as Record<string, unknown>;
}
