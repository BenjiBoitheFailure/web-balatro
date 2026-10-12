# SMODS / Pokermon on web-balatro — status notes

## Status: NOT yet proven. Nothing here has been run against real Balatro, Steamodded or Pokermon.

Verified (node, synthetic inputs): `node test/run.js` (26 unit tests), `node test/build-smoke.js`
(end-to-end buildFromSource with an in-memory JSZip fake and a *stubbed* TOML parser).
Not verified: the rewritten Lua compiling under Lua 5.1 (no Lua binary available here — run
`luac5.1 -p` over the output), anything in a real browser, Pokermon's own patches/assets.

## Apply to a branch (I could not create one from my sandbox)

    git checkout -b smods-pokermon
    cp <these>/lua-compat.js <these>/lovely-patcher.js <these>/build.js .
    cp -r <these>/test .
    # index.html: load the new scripts BEFORE build.js, after toml.js
    #   <script src="lua-compat.js"></script>
    #   <script src="lovely-patcher.js"></script>
    # then edit patches.js (web_patches.lua) as below.

## Findings in the original build (from reading build.js / patches.js / toml.js / mods.js)

1. Crash cause: love.js is PUC Lua 5.1; `goto continue` is a syntax error there, and gives exactly
   `'=' expected near 'continue'`. Fixed by lua-compat.js, run over every .lua in the archive
   (dump, Steamodded, mods). Unsupported goto shapes fail the build with file:line.
2. "SMODS patches skipped": build.js did `continue` on every patch whose target starts with
   `=[SMODS`. Those targets are Steamodded's own runtime-loaded files, not files in the zip. Mods were
   also copied into Mods/ only at the very end, so they couldn't be patched. Now: mods are copied
   first, `=[SMODS <id> "<path>"]` is resolved to `Mods/<folder>/<path>` via mod id (manifest .json
   `id` or `--- MOD_ID:` header; `_` = Steamodded core, found by folder name/layout).
3. `pattern` patches used `String.replace` with a substring: silently no-ops if indentation differs,
   only first match, glued payload onto the same line, and `$&`/`$1` in Lua payloads were
   interpreted. Replaced with line-based, whitespace-trimmed, wildcard matching (Lovely semantics).
4. `regex` patches: no multiline flag, Rust `(?P<name>)` is a JS SyntaxError, only the first `\n` in
   the payload got `line_prepend`, `limit` was off by one. Fixed.
5. `copy` ignored `position = "prepend"/"append"` (only knew "before"); `module` names with more than
   one dot only had the first dot converted.
6. `[vars]` / `{{lovely:...}}` were never applied (code commented out and `vars` never populated).
7. Priority sorted descending. I believe Lovely applies LOWER values first (Steamodded uses a
   negative priority so it runs first). Controlled by LOVELY_PRIORITY_ASCENDING in build.js — VERIFY.
8. Failures were silent. Now: `window.lastBuildReport` + console lists unmatched/skipped/errored
   patches and any ffi/jit usage; status line shows the warning count.

## patches.js (web_patches.lua) edits to make by hand

Replace the final lines (`-- Patch load for smods` / `load = loadstring`) with:

    local _load, _loadstring = load, loadstring
    load = function(chunk, chunkname, mode, env)
        local f, err
        if type(chunk) == "string" then
            f, err = _loadstring(chunk, chunkname)
        else
            f, err = _load(chunk, chunkname)
        end
        if f and env then setfenv(f, env) end
        return f, err
    end

(`load = loadstring` drops the chunk name — which Steamodded uses in its `=[SMODS ...]` names — and
the env argument.)

In `FakeChannel:push`, replace the print line with:

    local kind = type(value) == "table" and value.type or value
    print("Pushing value to channel: ", tostring(kind) .. " - " .. self.name)

(`value.type .. " - "` throws if a mod pushes a string or a table without `.type`.)

## Pokermon: open questions that decide feasibility

- Its own lovely patches: which targets/patch types? Run the build and read `lastBuildReport`.
- Remaining Steamodded runtime needs (ffi via nativefs is shimmed; `lovely` shim only has `mod_dir`).
- Size: 250+ Jokers worth of atlases/audio inside a wasm heap + IndexedDB cache — memory/load time.
- Any `goto` shape the transform refuses (will be listed with file:line).
