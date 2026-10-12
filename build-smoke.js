// node test/build-smoke.js
// Exercises buildFromSource() end-to-end against an in-memory fake of JSZip,
// with toml.parse STUBBED. It proves the control flow (mod copy -> SMODS target
// resolution -> patching -> goto pass -> report), not real Balatro/SMODS/Pokermon.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');

class FakeZip {
  constructor(files) { this.files = new Map(files); }
  static async loadAsync(blob) { return (globalThis.__zip = new FakeZip(globalThis.__initialFiles)); }
  _entry(p) {
    if (!this.files.has(p)) return null;
    const d = this.files.get(p);
    return { dir: false, async: async () => (typeof d === 'string' ? d : await d.text()) };
  }
  file(p, data) { if (data === undefined) return this._entry(p); this.files.set(p, data); return this; }
  folder(prefix) {
    const self = this, pre = prefix.replace(/\/?$/, '/');
    return { folder: (n) => self.folder(pre + n), file: (n, d) => self.file(pre + n, d) };
  }
  forEach(cb) { for (const p of this.files.keys()) cb(p, { dir: false }); }
  async generateAsync() { return new Blob(['zip']); }
}

const F = (name, text) => new File([text], name);
const els = { progressBar: { value: '' }, status: { innerText: '' } };

globalThis.window = globalThis;
globalThis.$ = (id) => els[id];
globalThis.JSZip = FakeZip;
globalThis.BufferReader = class { constructor() { this.view = { byteLength: 4 }; this.offset = 0; }
  string() { return 'PK\x03\x04'; } step() {} bytes() { return new Uint8Array(4); } };
globalThis.window.patches = { 'web_patches.lua': '-- stub', 'nativefs.lua': '-- fake nativefs' };

// Stubbed TOML: one patch for the game, one onto Steamodded's own source, one onto Pokermon.
const tomls = {
  'core.toml': { manifest: { priority: -10 }, patches: [
    { pattern: { target: 'game.lua', pattern: 'self.x = 1', position: 'after', payload: 'self.y = 2', match_indent: true } },
    { regex: { target: '=[SMODS _ "src/utils.lua"]', pattern: '^function f\\(\\)$', position: 'after', payload: ' -- patched', } },
    { module: { source: 'libs/nativefs/nativefs.lua', before: 'main.lua', name: 'nativefs' } },
  ] },
  'pk.toml': { manifest: { priority: 0 }, patches: [
    { pattern: { target: '=[SMODS pokermon "items/x.lua"]', pattern: 'local v = 1', position: 'at', payload: 'local v = 2' } },
    { pattern: { target: 'game.lua', pattern: 'THIS DOES NOT EXIST', position: 'at', payload: 'x' } },
    { pattern: { target: '=[SMODS nosuchmod "a.lua"]', pattern: 'a', position: 'at', payload: 'b' } },
  ] },
};
globalThis.toml = { parse: (t) => tomls[t.trim()] };

const load = (f) => vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), { filename: f });
load('lua-compat.js'); load('lovely-patcher.js'); load('build.js');

globalThis.__initialFiles = [
  ['main.lua', "G:start_up()\nif os == 'OS X' or os == 'Windows' then\nend\n"],
  ['globals.lua', 'F_SOUND_THREAD = true\n'],
  ['resources/shaders/hologram.fs', 'int n = glow_samples;\n'],
  ['game.lua', 'function G()\n    self.x = 1\n    for i=1,3 do\n      if i==2 then goto continue end\n      print(i)\n      ::continue::\n    end\nend\n'],
];

const mods = {
  smods: { lovely: { 'core.toml': F('core.toml', 'core.toml') }, src: { 'utils.lua': F('utils.lua', 'function f()\nend\n') },
           libs: { nativefs: { 'nativefs.lua': F('nativefs.lua', 'local ffi=require("ffi")') } } },
  Pokermon: { 'Pokermon.json': F('Pokermon.json', '{"id":"pokermon"}'),
              lovely: { 'pk.toml': F('pk.toml', 'pk.toml') },
              items: { 'x.lua': F('x.lua', 'local v = 1\nfor _,a in ipairs(t) do\n if a then goto continue end\n ::continue::\nend\n') } },
};

(async () => {
  const out = await buildFromSource(new Blob(['x']), mods);
  assert(out instanceof Blob);
  const rd = async (p) => await globalThis.__zip._entry(p).async();
  const game = await rd('game.lua');
  assert(/self\.x = 1\n    self\.y = 2\n/.test(game), 'pattern inserted on its own line with indent');
  assert(!/goto/.test(game) && /repeat/.test(game), 'game.lua goto rewritten');
  assert(/function f\(\) -- patched/.test(await rd('Mods/smods/src/utils.lua')), 'SMODS-internal regex patch applied');
  const pk = await rd('Mods/Pokermon/items/x.lua');
  assert(/local v = 2/.test(pk) && !/goto/.test(pk), 'Pokermon patch + goto rewrite');
  assert((await rd('nativefs.lua')) === '-- fake nativefs', 'web nativefs shim wins over SMODS ffi one');
  assert(/require 'nativefs'/.test(await rd('main.lua')), 'module require appended');
  const r = globalThis.lastBuildReport;
  console.log(JSON.stringify(r, null, 2));
  assert.strictEqual(r.applied, 3, 'game pattern + SMODS regex + Pokermon pattern applied');
  assert.strictEqual(r.unmatched.length, 1, 'bad pattern is REPORTED, not silent');
  assert.strictEqual(r.skipped.length, 1, 'unknown mod id is REPORTED');
  assert.strictEqual(r.gotoRewrites, 2, 'game.lua + Pokermon items/x.lua rewritten');
  assert(r.luaWarnings.some((w) => /ffi/.test(w)), 'ffi use is flagged');
  assert.strictEqual(els.status.innerText.startsWith('Done with 2 patch warning'), true);
  console.log('\nsmoke test passed');
})().catch((e) => { console.error(e); process.exit(1); });
