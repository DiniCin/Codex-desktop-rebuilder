# Codex Intel Rebuilder

This project lets you run the official Intel Codex Desktop app (an Electron app) on an Intel Mac with **older macOS releases that the official build no longer targets**, depending on your macOS version. The official app currently require a  macOS `12.0` as minimum, while this rebuild targets MacOS `11.7.11`.

It works by taking the official `Codex.dmg`, extracting its application logic (`app.asar` / `app.asar.unpacked`), swapping in an x64 build of Electron (downgrading it if necessary for OS compatibility), rebuilding every native (compiled) module for that Electron/architecture combination, and reassembling everything into a new, self-contained `Codex_Intel_os11.app`.

## Who actually needs this

- **Intel Macs with Older macOS versions** If your Mac is also running an old macOS release (this script has been developed and tested against **macOS 11 Big Sur**), the official app's bundled Electron version may require a newer macOS than you have (Electron 38+ requires macOS 12.0 Monterey or later). This script detects that mismatch automatically and falls back to the last Electron release line that still supports your OS (currently Electron 37.5.1 for macOS 11).

If you're on a reasonably modern Intel Mac (macOS 12+), just use the officlial build.

## Prerequisites

1. **Node.js**: installed on your system (any reasonably recent version; developed against Node 22).
2. **Codex CLI**: you must have the official `@openai/codex` CLI installed globally, since we extract its x64 `codex` and `rg` binaries from it.
   ```
   npm install -g @openai/codex
   ```
3. **Codex.dmg**: the official Intel x64 installer, placed in this directory.
   - Download: <https://developers.openai.com/codex/app>
4. **Xcode Command Line Tools** (for compiling native modules from source when no prebuilt binary is available): `xcode-select --install`. Some native modules additionally require **libffi** (`brew install libffi`) — see Known Limitations below.

## How to Build

```
node rebuild_codex.js
```

For a fully clean build (re-downloads/re-extracts everything, ignoring any cached resources):

```
node rebuild_codex.js --clean
```

To force a specific Electron version instead of the automatic macOS-compatibility fallback:

```
node rebuild_codex.js --electron-version=X.Y.Z
```

This script will:

1. Mount `Codex.dmg` and extract `app.asar`, `app.asar.unpacked`, the app icon, and `Info.plist`.
2. Read the Electron version the app expects from its bundled `package.json`. If your macOS is too old for that version, automatically fall back to the newest Electron release that still supports your OS, and correct `LSMinimumSystemVersion` in `Info.plist` to match.
3. Download and assemble the appropriate x64 Electron runtime.
4. Patch a known Electron-version-specific window-focus regression (see below).
5. **Discover and rebuild every native (compiled `.node`) module** found anywhere under `app.asar.unpacked` — not just a fixed list — recompiling or re-fetching a prebuilt binary for the target Electron version and x64 architecture.
6. Copy the x64 `codex` and `rg` binaries from your local global CLI installation.
7. Re-sign and clear the quarantine attribute so macOS will actually launch the resulting app.
8. Generate `Codex_Intel_os11.app`.

> **Note:** The script caches extracted DMG resources and the downloaded Electron zip to speed up subsequent builds. Use `--clean` whenever you've updated `Codex.dmg` or the CLI, to avoid reusing stale files.

## What this version fixes (and why it's more involved than a simple architecture swap)

Earlier versions of this script only downgraded Electron and rebuilt two hardcoded native modules (`better-sqlite3`, `node-pty`). Getting a fully *working* app — one that actually accepts keyboard input and successfully opens its local database — required tracking down several deeper, non-obvious issues:

- **Keyboard input completely broken on the older-Electron fallback path.** On the Electron 37.5.1 fallback (used for macOS 11), the app's primary window silently came up non-focusable: grey/inactive traffic lights, an `AXDialog` accessibility subrole instead of the normal `AXStandardWindow`, and no keystrokes ever reaching the renderer — with no error logged anywhere. Root cause: the app's window-creation code passes a `focusable` option that is `undefined` (not omitted) whenever the caller doesn't explicitly request non-focusable, which is the normal case for the primary window. Newer Electron versions treat an explicitly-`undefined` `focusable` value the same as "not set" and default to `true`; Electron 37.5.1 does not, and defaults to `false` instead. **Fix:** the script patches the built main-process bundle to coalesce that value (`focusable:X??!0`) before it reaches the `BrowserWindow` constructor. Since the exact minified variable name and surrounding code changes with every OpenAI release, this patch locates the right spot via a structural anchor rather than a hardcoded string, and safely no-ops (with a clear warning) if that anchor ever stops matching in a future release.

- **Only two of several native modules were being rebuilt.** The app ships more native (compiled) dependencies than just `better-sqlite3`/`node-pty` — for example `node-mac-permissions`, `objc-js`, and deeply-nested transitive modules like `node-hid` and `@serialport/bindings-cpp` pulled in by an internal device-support package. Any of these left un-rebuilt are still compiled for the *original* Electron version and architecture, and will crash with a `NODE_MODULE_VERSION` mismatch the moment the app tries to use them — which can surface as a **misleadingly unrelated error** (a "cannot access its local database" dialog was actually caused by an unrelated permissions module failing to load). **Fix:** the script now scans the entire `app.asar.unpacked` tree for `.node` files, identifies each owning package purely from `node_modules` path structure (OpenAI's build strips `package.json` out of these folders, so that can't be used), resolves a version from the app's own top-level dependencies where possible (falling back to "latest" otherwise), and rebuilds all of them the same way.

- **The focusable-window patch could silently reintroduce stale native modules.** Applying the fix above requires a full `app.asar` extract → edit → repack cycle. A subtlety of the `asar` packing tool bit us here twice: repacking without correctly specifying which directories should stay "unpacked" seals native modules back into `app.asar` as ordinary packed content — including the *original*, pre-rebuild (wrong-ABI) binaries, since those are what get pulled in during the extract step. Electron then extracts and loads that stale, sealed-in copy at every launch, completely bypassing whatever gets correctly rebuilt afterward in the sibling `app.asar.unpacked` folder. This produced an extremely persistent, deterministic crash (identical error, identical file checksum) that survived many rebuild attempts because the repack step recreated it identically every time. **Fix:** the script now derives the correct `--unpack-dir` glob patterns from the actual native module directories found during extraction, and — critically — verifies after repacking that a sample native module file genuinely ended up unpacked (0 bytes when extracted from the new archive) before ever touching the working `app.asar`. If that verification fails, the build throws loudly and leaves the previous working `app.asar` untouched, rather than silently shipping a broken one.

## How to Run

Open the generated app:

```
open Codex_Intel_os11.app
```

If you see "App is damaged" or "Operation not permitted", clear the quarantine attribute:

```
xattr -cr Codex_Intel_os11.app
```

## Updates

**Note:** This is a manual port. Auto-updates will **not** work.

To update:

1. Download the new `Codex.dmg` from OpenAI.
2. Replace the old `Codex.dmg` in this folder.
3. If the Codex CLI also updated, run `npm update -g @openai/codex`.
4. Run `node rebuild_codex.js --clean` to ensure a fresh build with the new files.

## Security Note

The built app launches with the `--no-sandbox` Electron flag via a wrapper script at `Contents/MacOS/Codex`. This disables Chromium's internal process sandbox, which is necessary to allow tools like **Playwright** to spawn browser subprocesses from within the integrated terminal. This is separate from the macOS Seatbelt sandbox Codex uses for workspace isolation. To enable network access inside the Codex terminal, set the following in your Codex `config.toml`:

```
[sandbox_workspace_write]
network_access = true
```

## ⚠️ Known Limitations & Risks

This is an unofficial, best-effort rebuild of a closed-source application. Treat it accordingly:

- **This is inherently fragile against upstream changes.** OpenAI can change the app's internal structure, dependency list, or minified code at any time without notice, and any of the following can silently break:
  - The structural anchor the focusable-window patch relies on to locate the right spot in the minified bundle. If it no longer matches, the script logs a warning and skips that patch — meaning a rebuilt app might launch but have broken keyboard input, exactly like the original bug this script works around.
  - The set of native modules the app depends on. New native dependencies should be picked up automatically by the scanning logic, but a change in how or where they're nested inside `node_modules` could confuse the path-based package-name detection.
  - The Electron version the app expects, and by extension whether the automatic macOS-compatibility fallback triggers at all, and to which version it falls back.

- **Native module rebuilds can fail, and the build does not stop when one does.** Not every native module has a prebuilt binary available for older Electron/macOS combinations, forcing a from-source compile via `node-gyp`. This requires a working C/C++ toolchain and can fail due to missing system libraries. For example, `objc-js` requires **libffi** headers (`ffi.h`) to compile, which are not present by default on macOS even with Xcode Command Line Tools installed; without `brew install libffi` (and pointing the build at its headers), that specific module's source build will fail and it may not work correctly in the final app. When a native module fails to build entirely, the script leaves whatever was there before untouched rather than deleting it, but that module's functionality may still be degraded or broken.

- **Falling back to Electron's "latest" version for a native dependency is a best-effort guess, not a guarantee.** For native modules that aren't direct dependencies of the app itself (deeply-nested transitive ones like `node-hid` or `@serialport/bindings-cpp`), there is no way to recover the *exact* version OpenAI originally shipped, because their manifests are stripped from the bundle. The script installs whatever npm considers "latest" for these instead. This is usually fine for compiled native addons (their public API rarely changes across versions) but is not verified to be identical to the original, and a future breaking change in one of these packages could cause subtle bugs.

- **This entire approach depends on assumptions about Electron's and asar's internal behavior** (how `focusable` defaults resolve, how `--unpack-dir` glob matching works, how packed vs. unpacked native modules are loaded at runtime) that were reverse-engineered through direct testing against specific Electron/asar versions, not from official guarantees. Future Electron or `@electron/asar` releases could change this behavior in ways that silently break the patches this script applies.

- **Auto-updates are disabled**, and there is no way to safely enable them — any update must go through re-running this rebuild process against a newer `Codex.dmg`.

- **This is not officially supported by OpenAI.** Bugs in the rebuilt app may or may not exist in the official build; please don't report issues encountered here to OpenAI's official support channels.

If you hit a build failure or a runtime crash not covered by the Troubleshooting section below, the most useful thing you can do is capture the **full console output** of the failing step — most issues encountered so far have required looking at exact log output (native module rebuild logs, `asar` header contents, live module-resolution traces) to diagnose precisely, rather than being obvious from the symptom alone.

## Troubleshooting

- **"Operation not permitted"**: the app is self-signed/unsigned. Remove the quarantine attribute: `xattr -cr Codex_Intel_os11.app`.
- **Blank window or grey/inactive traffic lights with no keyboard input**: usually means the focusable-window patch didn't apply (check the build log for a warning around "Patching main-process bundle for focusable-window regression"). This most likely means OpenAI's minified code changed enough that the structural anchor no longer matches — see Known Limitations above.
- **"Cannot access its local database" or any `NODE_MODULE_VERSION` mismatch error at launch**: a native module wasn't correctly rebuilt, or (if you've hit this on an unmodified checkout of this script) got resealed into `app.asar` as stale packed content during the focusable-window patch step. Check the build log for `Verified <path> is genuinely unpacked in the new archive` — if that line is missing or shows a warning instead, that repack step failed its own safety check and the resulting build should not be trusted.
- **Build fails compiling a native module (`node-gyp` errors)**: ensure Xcode Command Line Tools are up to date (Xcode 15+ recommended for C++20 support); try `xcode-select --install`. If the error mentions a missing header like `ffi.h`, the module requires a system library not installed by default — see Known Limitations above.
- **"Could not find local x64 Codex binary"**: ensure `@openai/codex` is installed globally and up to date (`npm list -g @openai/codex`).
- **"No network in Terminal"**: set `network_access = true` in your Codex `config.toml` (see Security Note above).
- **Playwright / browser spawning issues**: should work out of the box thanks to `--no-sandbox`; if issues persist, ensure network access is enabled as above.
- **Sparkle auto-updater crash on launch**: expected and harmless — the app should still function normally; this addon simply isn't rebuilt since auto-updates aren't supported by this project regardless.
