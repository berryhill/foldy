const invalid = (): never => { throw Error('UNSUPPORTED_ACTIVE_CONTENT'); };

/** Inspection-only view: never write this string into the release. This bounded
 * lexer is deliberately NOT a general HTML parser. Accept only unambiguous JSON
 * data blocks in ordinary HTML; keep all other bytes visible to closure checks.
 * Authored content remains under script-src 'none'. */
export function staticHtmlInspection(text: string): string {
  if (!/<\/?script\b/i.test(text)) return text;
  // Foreign content and alternate tokenizer states require a real HTML parser.
  if (/<\/?(?:svg|math|textarea|xmp|iframe|noembed|noframes|noscript|plaintext|template)\b/i.test(text) || text.includes('\0')) invalid();
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf('<', cursor);
    if (start < 0) { parts.push(text.slice(cursor)); break; }
    parts.push(text.slice(cursor, start));
    if (text.startsWith('<!--', start)) {
      const end = text.indexOf('-->', start + 4);
      if (end < 0 || /<!--|--!>/.test(text.slice(start + 4, end))) invalid();
      parts.push(text.slice(start, end + 3)); cursor = end + 3; continue;
    }
    const rest = text.slice(start);
    const doctype = /^<!doctype html\s*>/i.exec(rest);
    if (doctype) { parts.push(doctype[0]); cursor = start + doctype[0].length; continue; }
    const tag = /^<\/?([a-z][a-z0-9:-]*)(?=[\t\n\r />])(?:[^"'<>]|"[^"<>]*"|'[^'<>]*')*>/i.exec(rest);
    if (!tag) invalid();
    const token = tag![0], name = tag![1].toLowerCase();
    if (name === 'script') {
      // Only quoted type and optional simple id. No src, handlers, duplicate or
      // unknown attributes, slash syntax, entities, or MIME normalization.
      const opening = /^<script((?:[\t\n\r ]+[a-z]+[\t\n\r ]*=[\t\n\r ]*(?:"[^"<>]*"|'[^'<>]*'))+)[\t\n\r ]*>$/.exec(token);
      if (!opening) invalid();
      const attributes = new Map<string, string>();
      for (const match of opening![1].matchAll(/([a-z]+)[\t\n\r ]*=[\t\n\r ]*(["'])(.*?)\2/g)) {
        if (attributes.has(match[1]) || !['type', 'id'].includes(match[1])) invalid();
        attributes.set(match[1], match[3]);
      }
      if (attributes.get('type') !== 'application/json' || (attributes.has('id') && !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(attributes.get('id')!))) invalid();
      const bodyStart = start + token.length, end = text.indexOf('</script>', bodyStart);
      if (end < 0) invalid();
      const body = text.slice(bodyStart, end);
      // Raw '<' can switch HTML script tokenizer states or terminate a block,
      // even inside JSON strings. JSON Unicode escapes are unambiguous instead.
      if (body.includes('<')) invalid();
      try { JSON.parse(body); } catch { invalid(); }
      parts.push(' '); cursor = end + '</script>'.length; continue;
    }
    parts.push(token); cursor = start + token.length;
    if ((name === 'style' || name === 'title') && !token.startsWith('</')) {
      const closing = new RegExp('</' + name + '[\\t\\n\\r ]*>', 'ig'); closing.lastIndex = cursor;
      const end = closing.exec(text);
      if (!end) invalid();
      parts.push(text.slice(cursor, end!.index + end![0].length)); cursor = end!.index + end![0].length;
    }
  }
  return parts.join('');
}
