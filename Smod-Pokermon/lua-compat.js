/*
 * lua-compat.js
 *
 * love.js runs PUC Lua 5.1, not LuaJIT. Lua 5.1 has no `goto`/labels, so
 * `goto continue` parses as the identifier `goto` followed by a stray name,
 * which is exactly:  game.lua:2370: '=' expected near 'continue'
 *
 * transformGoto() rewrites the one idiom that can be translated safely:
 *
 *     for ... do            for ... do repeat
 *       ... goto X ...   =>    ... do break end ...
 *       ::X::                until true
 *     end                   end
 *
 * Anything else (goto out of a nested loop, backward jumps, labels that are
 * not the last statement of a for/while body, a loop that also uses `break`)
 * is NOT guessed at: it throws with file:line so the build fails loudly
 * instead of shipping Lua that will not compile.
 *
 * Line numbers are preserved (no newlines are added or removed).
 */
(function (root) {
  'use strict';

  function tokenize(src) {
    const toks = [];
    const n = src.length;
    let i = 0, line = 1;
    const numRe = /0[xX][0-9a-fA-F.]*(?:[pP][+-]?\d+)?[A-Za-z]*|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[A-Za-z]*/y;
    const countLines = (a, b) => { for (let k = a; k < b; k++) if (src.charCodeAt(k) === 10) line++; };
    const longLevel = (at) => {
      let j = at + 1, lvl = 0;
      while (src[j] === '=') { lvl++; j++; }
      return src[j] === '[' ? lvl : -1;
    };
    const skipLong = (at, lvl) => {
      const close = ']' + '='.repeat(lvl) + ']';
      const end = src.indexOf(close, at + lvl + 2);
      return end < 0 ? n : end + close.length;
    };

    while (i < n) {
      const c = src[i];
      if (c === '\n') { line++; i++; continue; }
      if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { i++; continue; }

      if (c === '-' && src[i + 1] === '-') {
        const lvl = src[i + 2] === '[' ? longLevel(i + 2) : -1;
        if (lvl >= 0) { const stop = skipLong(i + 2, lvl); countLines(i, stop); i = stop; }
        else { while (i < n && src[i] !== '\n') i++; }
        continue;
      }

      const start = i, startLine = line;

      if (c === '"' || c === "'") {
        i++;
        while (i < n && src[i] !== c) {
          if (src[i] === '\\') { if (src[i + 1] === '\n') line++; i++; }
          i++;
        }
        i++;
        toks.push({ t: 'str', v: src.slice(start, i), s: start, e: i, line: startLine });
        continue;
      }

      if (c === '[') {
        const lvl = longLevel(i);
        if (lvl >= 0) {
          const stop = skipLong(i, lvl);
          countLines(i, stop);
          i = stop;
          toks.push({ t: 'str', v: src.slice(start, i), s: start, e: i, line: startLine });
          continue;
        }
      }

      if (/[A-Za-z_]/.test(c)) {
        i++;
        while (i < n && /[A-Za-z0-9_]/.test(src[i])) i++;
        toks.push({ t: 'name', v: src.slice(start, i), s: start, e: i, line: startLine });
        continue;
      }

      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
        numRe.lastIndex = i;
        const m = numRe.exec(src);
        i = m ? i + m[0].length : i + 1;
        toks.push({ t: 'num', v: src.slice(start, i), s: start, e: i, line: startLine });
        continue;
      }

      if (c === ':' && src[i + 1] === ':') {
        i += 2;
        toks.push({ t: 'op', v: '::', s: start, e: i, line: startLine });
        continue;
      }

      i++;
      toks.push({ t: 'op', v: c, s: start, e: i, line: startLine });
    }
    return toks;
  }

  const isLoop = (f) => f.kind === 'loop' || f.kind === 'repeat';

  function transformGoto(src, fileName) {
    if (!/\bgoto\b|::/.test(src)) return src;
    const toks = tokenize(src);
    const fail = (tok, msg) => { throw new Error((fileName || '?') + ':' + tok.line + ': ' + msg); };

    const root = { kind: 'root', labels: [], breaks: 0 };
    const stack = [root];
    const gotos = [];
    const allLabels = [];
    const mk = (kind, extra) => Object.assign({ kind, labels: [], breaks: 0 }, extra || {});

    const innermostLoop = () => {
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].kind === 'function' || stack[k].kind === 'root') return null;
        if (isLoop(stack[k])) return stack[k];
      }
      return null;
    };
    const chain = () => {
      const out = [];
      for (let k = stack.length - 1; k >= 0; k--) {
        out.push(stack[k]);
        if (stack[k].kind === 'function' || stack[k].kind === 'root') break;
      }
      return out;
    };

    for (let i = 0; i < toks.length; i++) {
      const tk = toks[i];
      if (tk.t === 'name') {
        switch (tk.v) {
          case 'for': case 'while': stack.push(mk('loop', { pendingDo: true })); break;
          case 'do': {
            const top = stack[stack.length - 1];
            if (top.kind === 'loop' && top.pendingDo) { top.pendingDo = false; top.doTok = tk; }
            else stack.push(mk('do'));
            break;
          }
          case 'function': stack.push(mk('function')); break;
          case 'if': stack.push(mk('if')); break;
          case 'repeat': stack.push(mk('repeat')); break;
          case 'end': case 'until': if (stack.length > 1) stack.pop(); break;
          case 'break': { const l = innermostLoop(); if (l) l.breaks++; break; }
          case 'goto': {
            const prev = toks[i - 1], nxt = toks[i + 1];
            const isMember = prev && prev.t === 'op' && (prev.v === '.' || prev.v === ':');
            if (nxt && nxt.t === 'name' && !isMember) {
              gotos.push({ tok: tk, nameTok: nxt, chain: chain() });
              i++;
            }
            break;
          }
        }
      } else if (tk.t === 'op' && tk.v === '::') {
        const nm = toks[i + 1], cl = toks[i + 2], after = toks[i + 3];
        if (nm && nm.t === 'name' && cl && cl.t === 'op' && cl.v === '::') {
          const top = stack[stack.length - 1];
          const lab = {
            name: nm.v, open: tk, close: cl, frame: top, used: false,
            atEnd: top.kind === 'loop' && !!after && after.t === 'name' && after.v === 'end',
          };
          top.labels.push(lab);
          allLabels.push(lab);
          i += 2;
        }
      }
    }

    for (const g of gotos) {
      const name = g.nameTok.v;
      let target = null, lab = null, crossed = false;
      for (const f of g.chain) {
        lab = f.labels.find((l) => l.name === name);
        if (lab) { target = f; break; }
        if (isLoop(f)) crossed = true;
      }
      if (!target) fail(g.tok, "goto '" + name + "': no visible label");
      if (crossed) fail(g.tok, "goto '" + name + "' jumps out of a nested loop (unsupported)");
      if (!lab.atEnd) fail(g.tok, "label '" + name + "' is not the last statement of a for/while body (unsupported)");
      if (target.breaks > 0) fail(g.tok, "loop containing label '" + name + "' also uses break (unsupported)");
      lab.used = true;
      g.edit = { s: g.tok.s, e: g.nameTok.e, text: 'do break end' };
    }

    const edits = gotos.map((g) => g.edit);
    for (const lab of allLabels) {
      if (lab.used) {
        edits.push({ s: lab.frame.doTok.e, e: lab.frame.doTok.e, text: ' repeat ' });
        edits.push({ s: lab.open.s, e: lab.close.e, text: ' until true ' });
      } else {
        edits.push({ s: lab.open.s, e: lab.close.e, text: ' ' });
      }
    }

    edits.sort((a, b) => b.s - a.s || b.e - a.e);
    let out = src;
    for (const ed of edits) out = out.slice(0, ed.s) + ed.text + out.slice(ed.e);
    return out;
  }

  // Cheap, regex-only warnings for other LuaJIT-isms. May produce false
  // positives (it does not skip comments/strings); it is advisory only.
  function scanIncompatibilities(src) {
    const checks = [
      [/\brequire\s*\(?\s*["']ffi["']/, "requires LuaJIT 'ffi' (not available in love.js)"],
      [/\bjit\.[A-Za-z_]+/, "uses the LuaJIT 'jit' library"],
      [/\b\d+U?LL\b/, '64-bit integer literal (LL/ULL)'],
      [/\brequire\s*\(?\s*["']string\.buffer["']/, "requires LuaJIT 'string.buffer'"],
      [/\brequire\s*\(?\s*["']table\.(?:new|clear)["']/, "requires LuaJIT 'table.new/clear'"],
    ];
    const out = [];
    for (const [re, msg] of checks) if (re.test(src)) out.push(msg);
    return out;
  }

  const api = { tokenize, transformGoto, scanIncompatibilities };
  root.LuaCompat = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
