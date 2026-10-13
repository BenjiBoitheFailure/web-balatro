// Requires (load BEFORE this file in index.html): toml.js, lua-compat.js, lovely-patcher.js

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

/**
 * Lovely applies lower `priority` values first (VERIFY against lovely docs;
 * Steamodded ships a negative priority so that it runs before other mods).
 * The original code sorted descending. Flip this constant if verification
 * shows otherwise.
 */
const LOVELY_PRIORITY_ASCENDING = true;

/**
 * @param {Blob | File} blob .zip or .exe of balatro
 * @param {Object<string, Object>} mods Nested object of mods
 * @returns {Promise<Blob>} .zip of patched source
 */
async function buildFromSource(blob, mods) {
    for (const [g, file] of [["toml", "toml.js"], ["LuaCompat", "lua-compat.js"], ["LovelyPatcher", "lovely-patcher.js"]]) {
        if (typeof window[g] === "undefined") {
            throw new Error(`"${g}" is not defined: ${file} was not loaded. Add <script src="${file}"></script> to index.html before build.js (check the Network tab for a 404 and hard-refresh with Ctrl+Shift+R).`)
        }
    }
    const progress_bar = $("progressBar")
    const status_text = $("status")

    progress_bar.value = "0"
    status_text.innerText = "Finding Source"

    const buffer = await blob.arrayBuffer()
    const reader = new BufferReader(buffer)

    // Search for "PK\x03\x04"
    while (true) {
        if (reader.string(4) === "PK\x03\x04") break
        reader.step(-3)
    }

    progress_bar.value = "30"
    reader.step(-4)
    const pkfile = reader.bytes(reader.view.byteLength - reader.offset)

    function get_file(path) {
        const file = zipfile.file(path);
        if (!file) {
            throw new Error(`Missing game file: "${path}". Check the game archive and mod patches.`);
        }
        return file.async("string");
    }

    function get_mod_file(mod, path) {
        let current = mods[mod]
        for (const chunk of path.split("/")) {
            if (chunk === "" || chunk === ".") continue
            current = current ? current[chunk] : undefined
        }
        if (!(current instanceof File)) {
            throw new Error(`Mod "${mod}" has no file "${path}"`)
        }
        return current.text()
    }

    function set_file(path, data) {
        zipfile.file(path, data);
    }

    progress_bar.value = "40"
    status_text.innerText = "Extracting zip"
    const zipfile = await JSZip.loadAsync(new Blob([pkfile]))

    /** Everything that did not apply cleanly. Shown in the console and on window.lastBuildReport. */
    const report = { applied: 0, unmatched: [], skipped: [], errors: [], luaWarnings: [], gotoRewrites: 0 }

    const patch_list = [];

    // Replace source with patched data from external tool.
    function parseLovelyDump(obj, path) {
        for (const [name, value] of Object.entries(obj)) {
            if (!(value instanceof File)) {
                parseLovelyDump(value, path + name + "/");
                continue;
            }
            set_file(path + name, value)
        }
    }

    if (mods["Dump from Lovely"]) {
        parseLovelyDump(mods["Dump from Lovely"], "")
    }

    // ------------------------------------------------------------------
    // Copy every mod into Mods/ FIRST. (It used to happen at the very end,
    // which made it impossible to patch Steamodded's own files, so every
    // `=[SMODS ...]` patch had to be skipped.)
    // ------------------------------------------------------------------
    function add_dir(dir, path) {
        for (const [name, entry] of Object.entries(dir)) {
            if (entry instanceof File) zipfile.file(path + name, entry)
            else add_dir(entry, path + name + "/")
        }
    }
    const mods_without_dump = {}
    for (const [mod_name, mod_data] of Object.entries(mods)) {
        if (mod_name != "Dump from Lovely") mods_without_dump[mod_name] = mod_data
    }
    add_dir(mods_without_dump, "Mods/")

    // Map Steamodded mod ids -> folder, so "=[SMODS <id> "<path>"]" targets can
    // be resolved to real files under Mods/<folder>/<path>.
    const modIndex = {}
    for (const [folder, tree] of Object.entries(mods_without_dump)) {
        for (const [fname, f] of Object.entries(tree)) {
            if (!(f instanceof File)) continue
            try {
                if (fname.endsWith(".json")) {
                    const j = JSON.parse(await f.text())
                    if (j && typeof j.id === "string") modIndex[j.id] = folder
                } else if (fname.endsWith(".lua")) {
                    const m = /^\s*---\s*MOD_ID\s*:\s*(\S+)/m.exec((await f.text()).slice(0, 2000))
                    if (m) modIndex[m[1]] = folder
                }
            } catch (_) { /* not a manifest */ }
        }
    }
    // "_" is Steamodded's own pseudo-id (VERIFY). Find its folder by name, then by layout.
    if (!modIndex["_"]) {
        const byName = Object.keys(mods_without_dump).find((n) => /smods|steamodded/i.test(n))
        const byLayout = Object.keys(mods_without_dump).find((n) => mods_without_dump[n].src && mods_without_dump[n].lovely)
        if (byName || byLayout) modIndex["_"] = byName || byLayout
    }

    function resolveTarget(target) {
        if (typeof target !== "string") return { error: "no target" }
        const m = /^=\[SMODS (\S+) "(.+)"\]$/.exec(target)
        if (m) {
            const folder = modIndex[m[1]]
            if (!folder) return { error: `no loaded mod with id "${m[1]}"` }
            return { path: "Mods/" + folder + "/" + m[2] }
        }
        if (target.startsWith("=[")) return { error: "unsupported virtual target" }
        return { path: target }
    }

    // Mods go here
    for (const [name, mod] of Object.entries(mods)) {
        if (name == "Dump from Lovely") continue

        const tomls = []
        if (mod["lovely.toml"]) {
            tomls.push({ toml: mod["lovely.toml"], path: "lovely.toml" })
        }
        if (mod["lovely"]) {
            for (const [fname, patch] of Object.entries(mod["lovely"])) {
                if (fname.endsWith(".toml")) tomls.push({ toml: patch, path: "lovely/" + fname })
            }
        }
        for (const file of tomls) {
            try {
                patch_list.push({
                    src: toml.parse(await file.toml.text()),
                    name: name,
                    file: file.path,
                    dont_patch: mod["dont_patch.txt"] ? true : false,
                })
            } catch (err) {
                report.errors.push(`${name}/${file.path}: TOML parse failure: ${err.message}`)
                console.error("Failure while parsing mod " + name + " file " + file.path)
                console.error(err)
            }
        }
    }

    const prio = (p) => (p.src.manifest && typeof p.src.manifest.priority === "number") ? p.src.manifest.priority : 0
    patch_list.sort((a, b) => LOVELY_PRIORITY_ASCENDING ? prio(a) - prio(b) : prio(b) - prio(a))

    let modules_to_load = {}

    for (const patch_data of patch_list) {
        status_text.innerText = "Applying mod " + patch_data.name
        const vars = patch_data.src.vars || {}
        const ex = (s) => LovelyPatcher.expandVars(s, vars, (w) => report.errors.push(`${patch_data.name}: ${w}`))

        for (const block of patch_data.src.patches || []) {
            const kind = block.pattern ? "pattern" : block.regex ? "regex" : block.copy ? "copy" : block.module ? "module" : null
            if (!kind) continue
            const patch = block[kind]
            const label = `${patch_data.name}/${patch_data.file} -> ${patch.target || patch.name || "?"} [${kind}]`

            try {
                if (kind === "module") {
                    // Even though the patch specifies 'load module BEFORE other file'
                    // We load it after to prevent missing objects.
                    const file_name = patch.name.replace(/\./g, "/") + ".lua"
                    set_file(file_name, await get_mod_file(patch_data.name, patch.source))
                    if (!patch_data.dont_patch) {
                        modules_to_load[patch.before] = modules_to_load[patch.before] || []
                        modules_to_load[patch.before].push(patch.name)
                    }
                    continue
                }

                if (patch_data.dont_patch) continue

                const res = resolveTarget(patch.target)
                if (res.error) { report.skipped.push(`${label}: ${res.error}`); continue }
                const file = zipfile.file(res.path)
                if (!file) { report.skipped.push(`${label}: missing target file ${res.path}`); continue }

                const contents = await file.async("string")
                let result
                if (kind === "pattern") {
                    result = LovelyPatcher.applyPattern(contents, Object.assign({}, patch, { pattern: ex(patch.pattern), payload: ex(patch.payload) }))
                } else if (kind === "regex") {
                    result = LovelyPatcher.applyRegex(contents, Object.assign({}, patch, { pattern: ex(patch.pattern), payload: ex(patch.payload) }))
                } else {
                    const texts = []
                    for (const f of patch.sources) {
                        texts.push("-- " + patch_data.name + " - " + f + "\n" + await get_mod_file(patch_data.name, f))
                    }
                    result = { contents: LovelyPatcher.applyCopy(contents, texts, patch.position), count: texts.length }
                }

                if (result.count === 0) {
                    report.unmatched.push(`${label}: pattern matched nothing: ${String(patch.pattern || "").trim().slice(0, 80)}`)
                } else {
                    report.applied++
                    set_file(res.path, result.contents)
                }
            } catch (err) {
                report.errors.push(`${label}: ${err.message}`)
                console.error(label, err)
            }
        }
    }

    for (const [path, module] of Object.entries(modules_to_load)) {
        const f = zipfile.file(path)
        if (!f) { report.skipped.push(`module load target missing: ${path}`); continue }
        let contents = await f.async("string")
        for (const to_require of module) {
            contents += `\nrequire '${to_require}'`
        }
        set_file(path, contents)
    }

    progress_bar.value = "50"
    status_text.innerText = "Applying Patches"

    // These deliberately overwrite same-named files from mods (e.g. Steamodded's
    // ffi-based nativefs.lua and its lovely module), so they must come after patching.
    // Work on a copy so rebuilding in the same page never stacks the extras twice.
    // Steamodded's modified nativefs has more API than the original web shim: add the commonly used rest.
    const NFS_EXTRA = [
        "nativefs.createDirectory = nativefs.createDirectory or nativefs.mkdir",
        "nativefs.append = nativefs.append or function(filename, contents) local old = nativefs.read(filename) or '' return nativefs.write(filename, old .. contents) end",
        "nativefs.getLastModified = nativefs.getLastModified or function(path) local i = nativefs.getInfo(path) return i and i.modtime end",
        "nativefs.mount = nativefs.mount or function() return true end",
        "nativefs.unmount = nativefs.unmount or function() return true end",
        "nativefs.getDriveList = nativefs.getDriveList or function() return {} end",
        "nativefs.smodsAddRedirect = nativefs.smodsAddRedirect or function() end",
    ].join("\n")
    const shims = Object.assign({}, window.patches)
    if (typeof shims["nativefs.lua"] === "string") {
        shims["nativefs.lua"] = shims["nativefs.lua"].replace(/return nativefs\s*$/, NFS_EXTRA + "\nreturn nativefs")
    }
    for (const patch_file of Object.keys(shims)) {
        zipfile.file(patch_file, shims[patch_file])
    }

    // Steamodded names its modules "SMODS.nativefs" / "SMODS.https", so the real (LuaJIT ffi) files live at
    // SMODS/nativefs.lua etc. in a Lovely dump, NOT at the root where the shim above lands. Replace any
    // non-mod-folder copy that requires ffi. https is stubbed: every call returns "unavailable".
    {
        const HTTPS_STUB = [
            "local https = {}",
            "local function unavailable() return 0, 'HTTPS is not available in the web build', {} end",
            "setmetatable(https, { __index = function() return unavailable end })",
            "return https",
        ].join("\n")
        const names = []
        zipfile.forEach((p, f) => { if (!f.dir && p.endsWith(".lua") && !p.startsWith("Mods/")) names.push(p) })
        report.shimmed = []
        for (const p of names) {
            const base = p.split("/").pop()
            let shim = null
            if (base === "nativefs.lua") shim = shims["nativefs.lua"]
            else if (base === "https.lua" || base === "smods-https.lua" || base === "luajit-curl.lua") shim = HTTPS_STUB
            if (!shim) continue
            const text = await zipfile.file(p).async("string")
            if (!/require\s*\(?\s*["']ffi["']/.test(text)) continue
            zipfile.file(p, shim)
            report.shimmed.push(p)
        }
    }

    // If source has been patched already, and it hasn't been overwritten by a dump, skip patching.
    if (!zipfile.file("web_patched") || mods["Dump from Lovely"]) {
        progress_bar.value = "60"

        {
            const main = zipfile.file("main.lua")
            let contents = await main.async("string")
            contents = 'require "web_patches"\n' + contents
            contents = contents.replace("if os == 'OS X' or os == 'Windows' then", "if false then")
            contents = contents.replace("G:start_up()", "G:start_up()\n    G.SOUND_MANAGER = { channel = { push = function() end } }")
            zipfile.file("main.lua", contents)
        }

        progress_bar.value = "70"

        {
            const contents = await zipfile.file("globals.lua").async("string")
            zipfile.file("globals.lua", contents.replace("F_SOUND_THREAD = true", "F_SOUND_THREAD = false"))
        }

        progress_bar.value = "80"

        {
            const contents = await zipfile.folder("resources").folder("shaders").file("hologram.fs").async("string")
            zipfile.folder("resources").folder("shaders").file("hologram.fs", contents.replace(/glow_samples;/g, "4;"))
        }

        zipfile.file("web_patched", "true")
    }

    // ------------------------------------------------------------------
    // Steamodded finds its own folder at runtime (find_self) by scanning the mods dir with nativefs.
    // That scan fails under the web nativefs shim, leaving SMODS.path nil and crashing with
    // "attempt to concatenate field 'path' (a nil value)". We already know the folder at build time,
    // so set it directly. Guarded: only applied if the exact assignment line is found (VERIFY in report).
    // Also records main.lua lines around find_self / SMODS.path / line 1333 for debugging.
    // ------------------------------------------------------------------
    {
        const mainFile = zipfile.file("main.lua")
        if (mainFile) {
            let text = await mainFile.async("string")
            const lines = text.split("\n")
            const ctx = []
            lines.forEach((l, i) => {
                if (/find_self|SMODS\.path\s*=|SMODS\.MODS_DIR\s*=|lovely_mod_dir|love_dir/.test(l) || Math.abs(i + 1 - 1333) <= 3) ctx.push((i + 1) + ": " + l)
            })
            report.mainLuaDebug = ctx.slice(0, 80)
            // Plain-text debug for the NFS crash: context around utils.lua:4648 and every NFS assignment.
            const dbg = []
            const smodsDir = modIndex["_"] ? "Mods/" + modIndex["_"] + "/" : null
            const scan = [["main.lua", lines]]
            if (smodsDir) {
                for (const f of ["src/core.lua", "src/utils.lua", "src/preflight/loader.lua", "src/preflight/core.lua"]) {
                    const zf = zipfile.file(smodsDir + f)
                    if (zf) scan.push([smodsDir + f, (await zf.async("string")).split("\n")])
                }
            }
            for (const [name, ls] of scan) {
                ls.forEach((l, i) => {
                    const near = name.endsWith("src/utils.lua") && Math.abs(i + 1 - 4648) <= 6
                    if (near || /\bNFS\s*=|SMODS\.NFS\b.*=|SMODS\s*=\s*\{/.test(l)) dbg.push(name + ":" + (i + 1) + ": " + l.trim().slice(0, 200))
                })
            }
            report.nfsDebug = dbg.slice(0, 80)
            console.log("[web-debug] main.lua context:\n" + report.mainLuaDebug.join("\n") + "\n\n[web-debug] NFS / utils.lua:4648:\n" + report.nfsDebug.join("\n"))
            const folder = modIndex["_"]
            const re = /^([ \t]*SMODS\.path[ \t]*=[ \t]*)find_self\([^\n]*\)[ \t]*$/m
            if (folder && re.test(text)) {
                text = text.replace(re, (m, pre) => pre + JSON.stringify("Mods/" + folder + "/") + "; SMODS.NFS = SMODS.NFS or NFS or require(\"SMODS.nativefs\") -- web build: path/NFS set at build time")
                zipfile.file("main.lua", text)
                report.smodsPathOverride = "Mods/" + folder + "/"
            } else {
                report.smodsPathOverride = folder ? "NOT APPLIED: no single-line 'SMODS.path = find_self(...)' found in main.lua" : "NOT APPLIED: Steamodded folder not identified"
            }
        }
    }

    // ------------------------------------------------------------------
    // Lua 5.1 compatibility pass over EVERY .lua in the archive (game files,
    // Lovely dump, Steamodded, mods). love.js is not LuaJIT, so `goto` must go.
    // ------------------------------------------------------------------
    progress_bar.value = "85"
    status_text.innerText = "Making Lua 5.1 compatible"
    const luaPaths = []
    zipfile.forEach((relPath, f) => { if (!f.dir && relPath.endsWith(".lua")) luaPaths.push(relPath) })
    const luaErrors = []
    for (const p of luaPaths) {
        const text = await zipfile.file(p).async("string")
        try {
            const out = LuaCompat.transformGoto(text, p)
            if (out !== text) { zipfile.file(p, out); report.gotoRewrites++ }
        } catch (e) {
            luaErrors.push(e.message)
        }
        for (const w of LuaCompat.scanIncompatibilities(text)) report.luaWarnings.push(p + ": " + w)
    }

    window.lastBuildReport = report
    console.log("Build report", report)
    if (report.unmatched.length) console.warn("Patches that matched nothing:\n" + report.unmatched.join("\n"))
    if (report.skipped.length) console.warn("Patches skipped:\n" + report.skipped.join("\n"))
    if (report.errors.length) console.error("Patch errors:\n" + report.errors.join("\n"))
    if (report.luaWarnings.length) console.warn("Possible LuaJIT-only code:\n" + report.luaWarnings.join("\n"))

    if (luaErrors.length) {
        status_text.innerText = "Build failed: unsupported goto/label (see console)"
        console.error("Unsupported goto/label usage:\n" + luaErrors.join("\n"))
        throw new Error("Unsupported goto/label usage in " + luaErrors.length + " place(s):\n" + luaErrors.join("\n"))
    }

    progress_bar.value = "90"

    window.lastZip = zipfile // debugging: await lastZip.file("main.lua").async("string")
    status_text.innerText = "Zipping zip"
    const game = await zipfile.generateAsync({ type: "blob" })
    progress_bar.value = "100"
    const warnCount = report.unmatched.length + report.skipped.length + report.errors.length
    status_text.innerText = warnCount
        ? `Done with ${warnCount} patch warning(s) - open the console / window.lastBuildReport`
        : "Done"

    return game
}
