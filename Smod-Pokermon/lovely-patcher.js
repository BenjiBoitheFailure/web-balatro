/*
 * lovely-patcher.js
 *
 * Pure functions implementing Lovely's patch types, written to match Lovely's
 * documented behaviour as closely as I can reproduce it WITHOUT having Lovely's
 * source in front of me. Items marked (VERIFY) should be checked against the
 * lovely-injector docs/source before trusting them.
 *
 *  pattern: matched against WHOLE LINES, leading/trailing whitespace ignored,
 *           `*` and `?` wildcards, multi-line patterns match consecutive lines.
 *           at = replace matched lines; before/after = insert payload lines.   (VERIFY)
 *  regex:   Rust regex syntax (we translate (?P<n>..) and leading (?i)/(?s)),
 *           multi-line mode on, $1 / ${1} / $name / ${name} / $$ in payload.   (VERIFY)
 *  copy:    position is "prepend" | "append".                                  (VERIFY)
 *
 * The previous implementation used String.replace with a plain substring and a
 * payload string; that (a) silently does nothing when indentation/whitespace
 * differs, (b) interprets $&, $1, $' inside Lua payloads, (c) only handled the
 * first match, and (d) glued payloads onto the same line as the pattern.
 */
(function (root) {
  'use strict';

  function expandVars(str, vars, warn) {
    if (typeof str !== 'string') return str;
    return str.replace(/\{\{lovely:([\w.]+)\}\}/g, (m, k) => {
      if (vars && Object.prototype.hasOwnProperty.call(vars, k)) return String(vars[k]);
      if (warn) warn('unknown lovely var ' + k);
      return m;
    });
  }

  function globToRegExp(pat) {
    let re = '';
    for (const ch of pat) {
      if (ch === '*') re += '.*';
      else if (ch === '?') re += '.';
      else re += ch.replace(/[.+^${}()|[\]\\\/-]/g, '\\$&');
    }
    return new RegExp('^' + re + '$');
  }

  function applyPattern(contents, patch) {
    const src = contents.split('\n');
    const pat = String(patch.pattern).split('\n').map((s) => s.trim());
    while (pat.length && pat[0] === '') pat.shift();
    while (pat.length && pat[pat.length - 1] === '') pat.pop();
    if (!pat.length) return { contents, count: 0 };

    const res = pat.map(globToRegExp);
    const trimmed = src.map((s) => s.trim());
    const hits = [];
    for (let i = 0; i + res.length <= src.length;) {
      let ok = true;
      for (let j = 0; j < res.length; j++) {
        if (!res[j].test(trimmed[i + j])) { ok = false; break; }
      }
      if (ok) { hits.push(i); i += res.length; } else i++;
    }

    const limit = patch.times != null ? patch.times : Infinity;
    const used = hits.slice(0, limit);
    const payload = patch.payload == null ? '' : String(patch.payload);

    for (let h = used.length - 1; h >= 0; h--) {
      const i = used[h];
      let pl = payload.split('\n');
      if (payload.endsWith('\n')) pl.pop();
      if (patch.match_indent) {
        const ind = /^[ \t]*/.exec(src[i])[0];
        pl = pl.map((l) => (l.length ? ind + l : l));
      }
      if (patch.position === 'at') src.splice(i, res.length, ...pl);
      else if (patch.position === 'before') src.splice(i, 0, ...pl);
      else src.splice(i + res.length, 0, ...pl);
    }
    return { contents: src.join('\n'), count: used.length };
  }

  function toJsRegex(pattern) {
    let flags = 'gm';
    let source = String(pattern);
    const m = /^\(\?([imsx]+)\)/.exec(source);
    if (m) {
      source = source.slice(m[0].length);
      for (const f of m[1]) {
        if (f === 'i' && !flags.includes('i')) flags += 'i';
        else if (f === 's' && !flags.includes('s')) flags += 's';
        else if (f === 'x') throw new Error('regex flag (?x) is not supported');
      }
    }
    source = source.replace(/\(\?P</g, '(?<');
    return new RegExp(source, flags);
  }

  function expandTemplate(tpl, m) {
    return tpl.replace(/\$(\$|\{(\w+)\}|(\w+))/g, (all, d, braced, bare) => {
      if (d === '$') return '$';
      const name = braced != null ? braced : bare;
      if (/^\d+$/.test(name)) return m[Number(name)] == null ? '' : m[Number(name)];
      const g = m.groups && m.groups[name];
      return g == null ? '' : g;
    });
  }

  function applyRegex(contents, patch) {
    const re = toJsRegex(patch.pattern);
    const prepend = patch.line_prepend || '';
    let tpl = patch.payload == null ? '' : String(patch.payload);
    if (prepend) tpl = tpl.split('\n').map((l) => prepend + l).join('\n');
    const limit = patch.times != null ? patch.times : (patch.limit != null ? patch.limit : Infinity);

    let out = '', last = 0, count = 0;
    for (const m of contents.matchAll(re)) {
      if (count >= limit) break;
      const rep = expandTemplate(tpl, m);
      const s = m.index;
      out += contents.slice(last, s);
      if (patch.position === 'at') out += rep;
      else if (patch.position === 'before') out += rep + m[0];
      else out += m[0] + rep;
      last = s + m[0].length;
      count++;
    }
    out += contents.slice(last);
    return { contents: out, count };
  }

  function applyCopy(contents, texts, position) {
    const joined = texts.join('\n');
    if (position === 'prepend' || position === 'before') return joined + '\n' + contents;
    return contents + '\n' + joined;
  }

  const api = { expandVars, globToRegExp, applyPattern, applyRegex, applyCopy, toJsRegex };
  root.LovelyPatcher = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
