// node test/run.js
// NOTE: there is no Lua interpreter in this environment, so Lua output is
// checked structurally (block balance, line count, expected text), NOT by
// compiling it with Lua 5.1. Run `luac5.1 -p` over the output for real proof.
const assert = require('assert');
const LC = require('../lua-compat.js');
const LP = require('../lovely-patcher.js');

let pass = 0, failN = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('ok   ' + name); }
  catch (e) { failN++; console.log('FAIL ' + name + '\n     ' + e.message); }
}

// Balanced-block sanity check using the tokenizer: every `do`/`if`/`function`
// needs an `end`; every `repeat` needs an `until`.
function balanced(code) {
  const t = LC.tokenize(code).filter((x) => x.t === 'name').map((x) => x.v);
  const c = (w) => t.filter((v) => v === w).length;
  return c('end') === c('if') + c('function') + c('do') && c('until') === c('repeat');
}
const nl = (s) => (s.match(/\n/g) || []).length;

test('simple for/continue', () => {
  const src = 'for i = 1, 3 do\n  if i == 2 then goto continue end\n  print(i)\n  ::continue::\nend\n';
  const out = LC.transformGoto(src, 't.lua');
  assert(!/\bgoto\b/.test(out) && !/::/.test(out));
  assert(/for i = 1, 3 do repeat/.test(out));
  assert(/do break end/.test(out));
  assert(/until true\s*end/.test(out));
  assert(balanced(out));
  assert.strictEqual(nl(out), nl(src));
});

test('while loop', () => {
  const src = 'while x < 3 do\n x = x + 1\n if x == 2 then goto continue end\n ::continue::\nend';
  const out = LC.transformGoto(src);
  assert(/while x < 3 do repeat/.test(out) && balanced(out));
});

test('nested loops each with their own label', () => {
  const src = [
    'for a in pairs(t) do',
    '  for b in pairs(a) do',
    '    if b then goto continue end',
    '    ::continue::',
    '  end',
    '  if a then goto continue end',
    '  ::continue::',
    'end',
  ].join('\n');
  const out = LC.transformGoto(src);
  assert(!/\bgoto\b/.test(out) && balanced(out));
  assert.strictEqual((out.match(/repeat/g) || []).length, 2);
});

test('goto inside nested function-free if/else chains', () => {
  const src = 'for i=1,2 do\n if a then goto continue elseif b then goto continue else x() end\n ::continue::\nend';
  const out = LC.transformGoto(src);
  assert.strictEqual((out.match(/do break end/g) || []).length, 2);
  assert(balanced(out));
});

test('no goto -> identical string', () => {
  const src = 'local a = 1\nprint(a)\n';
  assert.strictEqual(LC.transformGoto(src), src);
});

test('goto/:: inside strings and comments untouched', () => {
  const src = 'local s = "goto continue ::x::" -- goto y ::z::\n--[[ goto q\n::w:: ]]\nlocal l = [[goto a ::b::]]\n';
  assert.strictEqual(LC.transformGoto(src), src);
});

test('obj.goto / obj:goto are not gotos', () => {
  const src = 'local o = {}\no.goto = 1\no:goto(x)\nprint(o.goto)\n';
  assert.strictEqual(LC.transformGoto(src), src);
});

test('unused label is removed', () => {
  const src = 'for i=1,2 do\n print(i)\n ::continue::\nend';
  const out = LC.transformGoto(src);
  assert(!/::/.test(out) && !/repeat/.test(out) && balanced(out));
});

test('goto out of nested loop -> throws with file:line', () => {
  const src = 'for a in x do\n for b in y do\n  goto continue\n end\n ::continue::\nend';
  assert.throws(() => LC.transformGoto(src, 'game.lua'), /game\.lua:3: .*nested loop/);
});

test('loop with own break -> throws', () => {
  const src = 'for a in x do\n if q then break end\n if r then goto continue end\n ::continue::\nend';
  assert.throws(() => LC.transformGoto(src, 'a.lua'), /also uses break/);
});

test('break inside a NESTED loop does not block the transform', () => {
  const src = 'for a in x do\n for b in y do break end\n if r then goto continue end\n ::continue::\nend';
  const out = LC.transformGoto(src);
  assert(/do break end/.test(out) && balanced(out));
});

test('label not at end of loop -> throws', () => {
  const src = 'for a in x do\n if r then goto continue end\n ::continue::\n print(a)\nend';
  assert.throws(() => LC.transformGoto(src, 'a.lua'), /not the last statement/);
});

test('goto with no label -> throws', () => {
  assert.throws(() => LC.transformGoto('goto nowhere', 'a.lua'), /no visible label/);
});

test('function inside loop header/body does not confuse block tracking', () => {
  const src = 'for _, f in ipairs(list) do\n  local g = function() return 1 end\n  if g() then goto continue end\n  run(f)\n  ::continue::\nend';
  const out = LC.transformGoto(src);
  assert(balanced(out) && /do break end/.test(out));
});

test('scanIncompatibilities', () => {
  assert(LC.scanIncompatibilities('local ffi = require("ffi")').length === 1);
  assert(LC.scanIncompatibilities('local x = 1').length === 0);
});

// ---- Lovely patcher ----
test('pattern: whitespace-insensitive line match, after + match_indent', () => {
  const src = 'function f()\n    local a = 1\n    return a\nend';
  const r = LP.applyPattern(src, { pattern: 'local a = 1', position: 'after', payload: 'local b = 2', match_indent: true });
  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.contents, 'function f()\n    local a = 1\n    local b = 2\n    return a\nend');
});

test('pattern: wildcard + at replaces the whole line', () => {
  const r = LP.applyPattern('x = 1\ny = 2\n', { pattern: 'y = *', position: 'at', payload: 'y = 99' });
  assert.strictEqual(r.contents, 'x = 1\ny = 99\n');
});

test('pattern: before keeps payload on its own line', () => {
  const r = LP.applyPattern('a\nb\nc', { pattern: 'b', position: 'before', payload: '-- hi' });
  assert.strictEqual(r.contents, 'a\n-- hi\nb\nc');
});

test('pattern: multi-line pattern', () => {
  const r = LP.applyPattern('a\n  b\n  c\nd', { pattern: 'b\nc', position: 'at', payload: 'X' });
  assert.strictEqual(r.contents, 'a\nX\nd');
});

test('pattern: $& and $1 in payload are NOT interpreted', () => {
  const r = LP.applyPattern('a\nb', { pattern: 'a', position: 'at', payload: 'x = "$&$1"' });
  assert.strictEqual(r.contents, 'x = "$&$1"\nb');
});

test('pattern: times limits matches; no match -> count 0', () => {
  const r = LP.applyPattern('a\na\na', { pattern: 'a', position: 'after', payload: 'z', times: 2 });
  assert.strictEqual(r.count, 2);
  assert.strictEqual(LP.applyPattern('a', { pattern: 'nope', position: 'at', payload: 'z' }).count, 0);
});

test('regex: rust named group + $name/${1} + multiline anchors', () => {
  const src = 'foo(1)\nfoo(2)\n';
  const r = LP.applyRegex(src, { pattern: '^foo\\((?P<n>\\d)\\)$', position: 'at', payload: 'bar(${n}, $1)' });
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.contents, 'bar(1, 1)\nbar(2, 2)\n');
});

test('regex: line_prepend on every payload line, times honoured', () => {
  const r = LP.applyRegex('A\nA\n', { pattern: '^A$', position: 'after', payload: 'x\ny', line_prepend: '  ', times: 1 });
  assert.strictEqual(r.contents, 'A  x\n  y\nA\n');
});

test('regex: leading (?i) flag', () => {
  const r = LP.applyRegex('Hello', { pattern: '(?i)hello', position: 'at', payload: 'bye' });
  assert.strictEqual(r.contents, 'bye');
});

test('copy: append / prepend', () => {
  assert.strictEqual(LP.applyCopy('T', ['a', 'b'], 'append'), 'T\na\nb');
  assert.strictEqual(LP.applyCopy('T', ['a', 'b'], 'prepend'), 'a\nb\nT');
});

test('vars expansion', () => {
  assert.strictEqual(LP.expandVars('x={{lovely:foo}}', { foo: 5 }), 'x=5');
});

console.log('\n' + pass + ' passed, ' + failN + ' failed');
process.exit(failN ? 1 : 0);
