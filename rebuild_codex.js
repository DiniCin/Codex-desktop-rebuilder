const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

// Configuration
const REPO_ROOT = __dirname;
const MOUNT_POINT = '/Volumes/CodexMount';
const DMG_PATH = path.join(REPO_ROOT, 'Codex.dmg');
const TEMP_DIR = path.join(REPO_ROOT, 'temp_build');
const FINAL_APP_PATH = path.join(REPO_ROOT, 'Codex_Intel.app');
const RESOURCES_DIR = path.join(REPO_ROOT, 'resources');
// detect CODEX_CLI_PATH dynamically
let CODEX_CLI_PATH = '/usr/local/lib/node_modules/@openai/codex';
let codexPathFound = false;

// Attempt 1: ask npm directly
try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const possiblePath = path.join(globalRoot, '@openai/codex');
    if (fs.existsSync(possiblePath)) {
        CODEX_CLI_PATH = possiblePath;
        codexPathFound = true;
        console.log(`Detected Codex CLI at: ${CODEX_CLI_PATH}`);
    }
} catch (e) {
    // fall through to attempt 2
}

// Attempt 2: scan nvm's installed node versions directly, since `npm root -g`
// run via execSync's subshell doesn't always inherit nvm's PATH the same way
// an interactive shell does.
if (!codexPathFound) {
    try {
        const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node');
        if (fs.existsSync(nvmDir)) {
            const versions = fs.readdirSync(nvmDir);
            for (const v of versions) {
                const candidate = path.join(nvmDir, v, 'lib', 'node_modules', '@openai', 'codex');
                if (fs.existsSync(candidate)) {
                    CODEX_CLI_PATH = candidate;
                    codexPathFound = true;
                    console.log(`Detected Codex CLI via nvm scan at: ${CODEX_CLI_PATH}`);
                    break;
                }
            }
        }
    } catch (e) {
        // fall through
    }
}

if (!codexPathFound) {
    console.log(`Could not find @openai/codex via npm root -g or nvm scan. Using default: ${CODEX_CLI_PATH}`);
}

// Helper for executing commands
function run(cmd, cwd = REPO_ROOT) {
    console.log(`> ${cmd}`);
    try {
        execSync(cmd, { cwd, stdio: 'inherit' });
    } catch (e) {
        console.error(`Command failed: ${cmd}`);
        process.exit(1);
    }
}

async function main() {
    // Handle --clean flag
    const cleanBuild = process.argv.includes('--clean');
    if (cleanBuild) {
        console.log("Clean build requested. Removing cached/transient files...");
        const toRemove = [
            RESOURCES_DIR,
            TEMP_DIR,
            path.join(REPO_ROOT, 'native_build_temp'),
            FINAL_APP_PATH,
            path.join(REPO_ROOT, 'package.json'),
        ];
        // Also remove any cached electron zips
        const electronZips = fs.readdirSync(REPO_ROOT).filter(f => f.startsWith('electron-') && f.endsWith('.zip'));
        electronZips.forEach(f => toRemove.push(path.join(REPO_ROOT, f)));

        for (const p of toRemove) {
            if (fs.existsSync(p)) {
                console.log(`  Removing ${path.basename(p)}`);
                fs.rmSync(p, { recursive: true, force: true });
            }
        }
        console.log("Clean complete.\n");
    }

    console.log("Starting Codex Rebuilder...");

    // 1. Prepare Resources (Mount DMG if needed)
    if (!fs.existsSync(RESOURCES_DIR)) {
        fs.mkdirSync(RESOURCES_DIR);
    }

    const requiredResources = [
        'app.asar',
        'electron.icns',
        'Info.plist'
    ];

    // Check if we have resources locally
    const missingResources = requiredResources.filter(r => !fs.existsSync(path.join(RESOURCES_DIR, r)));

    if (missingResources.length > 0) {
        console.log(`Missing resources (${missingResources.join(', ')}). Mounting DMG...`);

        let mounted = false;
        if (!fs.existsSync(MOUNT_POINT)) {
            // Check if already mounted by user?
            try {
                // Try to mount
                run(`hdiutil attach "${DMG_PATH}" -nobrowse -mountpoint "${MOUNT_POINT}"`);
                mounted = true;
            } catch (e) {
                console.log("Mount failed or already mounted. Checking...");
            }
        } else {
            console.log("Mount point exists, assuming mounted.");
            mounted = true;
            // If strictly it's just a folder, we might fail, but let's assume valid mount or previous run leftover
        }

        try {
            const appPath = path.join(MOUNT_POINT, 'Codex.app/Contents');
            const resPath = path.join(appPath, 'Resources');

            if (fs.existsSync(path.join(resPath, 'app.asar'))) {
                // Copy app.asar
                if (!fs.existsSync(path.join(RESOURCES_DIR, 'app.asar'))) {
                    console.log("Extracting app.asar...");
                    run(`cp "${path.join(resPath, 'app.asar')}" "${path.join(RESOURCES_DIR, 'app.asar')}"`);
                }

                // Copy electron.icns
                if (!fs.existsSync(path.join(RESOURCES_DIR, 'electron.icns'))) {
                    console.log("Extracting electron.icns...");
                    run(`cp "${path.join(resPath, 'electron.icns')}" "${path.join(RESOURCES_DIR, 'electron.icns')}"`);
                }

                // Copy Info.plist
                if (!fs.existsSync(path.join(RESOURCES_DIR, 'Info.plist'))) {
                    console.log("Extracting Info.plist...");
                    run(`cp "${path.join(appPath, 'Info.plist')}" "${path.join(RESOURCES_DIR, 'Info.plist')}"`);
                }

                // Copy app.asar.unpacked structure
                if (!fs.existsSync(path.join(RESOURCES_DIR, 'app.asar.unpacked'))) {
                    console.log("Extracting app.asar.unpacked...");
                    if (fs.existsSync(path.join(resPath, 'app.asar.unpacked'))) {
                        run(`cp -r "${path.join(resPath, 'app.asar.unpacked')}" "${path.join(RESOURCES_DIR, 'app.asar.unpacked')}"`);
                    } else {
                        fs.mkdirSync(path.join(RESOURCES_DIR, 'app.asar.unpacked'));
                    }
                }
            } else {
                throw new Error("Could not find Codex.app/Contents/Resources/app.asar in DMG");
            }
        } finally {
            if (mounted) {
                // Try to detach, don't fail if busy
                try {
                    run(`hdiutil detach "${MOUNT_POINT}"`);
                } catch (e) {
                    console.warn("Failed to unmount, ignoring.");
                }
            }
        }
    }

    // 2. Read Electron Version from extracted app.asar
    console.log("Reading Electron version...");
    const localAppAsar = path.join(RESOURCES_DIR, 'app.asar');
    const pkgJsonPath = path.join(REPO_ROOT, 'package.json');

    // We only extract if we haven't already or if we want to force check
    run(`npx -y @electron/asar extract-file "${localAppAsar}" package.json > "${pkgJsonPath}"`);

    if (!fs.existsSync(pkgJsonPath)) {
        console.error("Failed to extract package.json");
        process.exit(1);
    }

    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    let electronVersion = pkg.devDependencies?.electron || pkg.dependencies?.electron;

    if (!electronVersion) {
        console.log("Could not find electron version, defaulting to 40.0.0 based on previous analysis.");
        electronVersion = '40.0.0';
    }

    // Clean version (remove ^ or ~)
    electronVersion = electronVersion.replace(/^[\^~]/, '');
    console.log(`App expects Electron Version: ${electronVersion}`);

    // Electron 38+ requires macOS 12 (Monterey) or later to even launch
    // (dyld will fail loading frameworks on older macOS). Allow override via
    // --electron-version=X.Y.Z flag or ELECTRON_VERSION_OVERRIDE env var;
    // otherwise auto-downgrade if running on macOS < 12 and the detected
    // version is 38+.
    const versionFlag = process.argv.find(a => a.startsWith('--electron-version='));
    const explicitOverride = versionFlag ? versionFlag.split('=')[1] : process.env.ELECTRON_VERSION_OVERRIDE;

    const FALLBACK_ELECTRON_FOR_OLDER_MACOS = '37.5.1'; // last major line supporting macOS 11 (Big Sur)

    if (explicitOverride) {
        console.log(`Using explicitly requested Electron version override: ${explicitOverride}`);
        electronVersion = explicitOverride;
    } else {
        const electronMajor = parseInt(electronVersion.split('.')[0], 10);
        let macOsMajor = null;
        let swVers = null;
        try {
            swVers = execSync('sw_vers -productVersion', { encoding: 'utf8' }).trim();
            macOsMajor = parseInt(swVers.split('.')[0], 10);
        } catch (e) {
            console.warn("Could not detect macOS version via sw_vers; skipping compatibility check.");
        }

        if (macOsMajor !== null && macOsMajor < 12 && electronMajor >= 38) {
            console.warn(`WARNING: Electron ${electronVersion} requires macOS 12 (Monterey) or later.`);
            console.warn(`You're running macOS ${swVers} (Big Sur or earlier). The app would fail to launch (dyld errors) if built against Electron ${electronVersion}.`);
            console.warn(`Falling back to Electron ${FALLBACK_ELECTRON_FOR_OLDER_MACOS}, the last release line confirmed to run on macOS 11.`);
            console.warn(`NOTE: The Codex app's bundled code was built for Electron ${electronVersion} and may rely on newer Electron APIs. Test thoroughly after rebuild.`);
            console.warn(`To force a specific version instead, rerun with --electron-version=X.Y.Z`);
            electronVersion = FALLBACK_ELECTRON_FOR_OLDER_MACOS;
        }
    }

    console.log(`Target Electron Version: ${electronVersion}`);

    // 3. Download Electron x64
    if (fs.existsSync(TEMP_DIR)) {
        fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEMP_DIR);

    const zipName = `electron-v${electronVersion}-darwin-x64.zip`;
    const downloadUrl = `https://github.com/electron/electron/releases/download/v${electronVersion}/${zipName}`;
    const zipPath = path.join(REPO_ROOT, zipName); // Cache zip in root

    if (!fs.existsSync(zipPath)) {
        console.log(`Downloading ${downloadUrl}...`);
        run(`curl -L -o "${zipPath}" "${downloadUrl}"`);
    } else {
        console.log("Using cached Electron zip.");
    }

    // 4. Extract Electron
    console.log("Extracting Electron...");
    run(`unzip "${zipPath}" -d "${TEMP_DIR}"`);

    // 5. Assemble Codex App
    console.log("Assembling Codex.app...");
    const electronApp = path.join(TEMP_DIR, 'Electron.app');
    const targetApp = FINAL_APP_PATH;

    if (fs.existsSync(targetApp)) {
        fs.rmSync(targetApp, { recursive: true, force: true });
    }
    run(`mv "${electronApp}" "${targetApp}"`);

    // Replace Resources
    const targetResources = path.join(targetApp, 'Contents/Resources');
    const defaultAsar = path.join(targetResources, 'default_app.asar');
    if (fs.existsSync(defaultAsar)) {
        fs.unlinkSync(defaultAsar);
    }

    fs.copyFileSync(localAppAsar, path.join(targetResources, 'app.asar'));

    // Copy Icon
    const localIcon = path.join(RESOURCES_DIR, 'electron.icns');
    if (fs.existsSync(localIcon)) {
        console.log("Applying custom App Icon...");
        // Destination might be electron.icns or whatever Info.plist specifies
        // We know from previous steps it expects 'electron.icns'
        fs.copyFileSync(localIcon, path.join(targetResources, 'electron.icns'));
    }

    // 6. Native Modules Replacement
    console.log("Handling native modules...");
    const targetUnpacked = path.join(targetResources, 'app.asar.unpacked');

    // Copy extracted unpacked folder from resources
    const localUnpacked = path.join(RESOURCES_DIR, 'app.asar.unpacked');
    if (fs.existsSync(localUnpacked)) {
        run(`cp -r "${localUnpacked}" "${targetUnpacked}"`);
    } else {
        fs.mkdirSync(targetUnpacked, { recursive: true });
    }

    // 6.5. Patch "focusable" default-value regression for downgraded Electron
    // ------------------------------------------------------------------
    // When the Codex app's main-process bundle creates most of its windows
    // (primary, secondary, hud, hotkey-window home/thread, etc.) via the
    // shared BrowserWindow-construction code, it forwards a `focusable`
    // option that is `undefined` whenever the caller didn't explicitly
    // request non-focusable (which is the normal case for the primary
    // window). On stock/newer Electron, an explicitly-present-but-undefined
    // `focusable` key falls back to Electron's documented default of
    // `true`. On Electron 37.5.1 -- the version we fall back to for
    // macOS < 12 compatibility -- this instead resolves to `false`,
    // silently creating an unfocusable primary window: grey traffic
    // lights, an AXDialog accessibility subrole instead of the normal
    // AXStandardWindow, and no keyboard input ever reaching the renderer,
    // with no error logged anywhere.
    //
    // We patch the built main-process bundle to coalesce that value to
    // `true` (`focusable:X??!0`) before it reaches the BrowserWindow
    // constructor. This is a no-op wherever the bug doesn't apply, so we
    // always run this patch regardless of which Electron version ended up
    // bundled -- it's cheap insurance.
    //
    // CRITICAL ORDERING NOTE: this step MUST run here -- right after the
    // pristine app.asar.unpacked tree is copied in from the DMG, and
    // BEFORE the native-module rebuild below overwrites better-sqlite3/
    // node-pty with freshly-built versions. Patching app.asar requires a
    // full extract-and-repack round trip, and `asar extract` doesn't just
    // read bytes out of the .asar file -- for anything the archive marks
    // "unpacked" it goes looking for the real file in the sibling
    // app.asar.unpacked folder on disk. If the native-module rebuild has
    // already run by this point, our freshly-built better-sqlite3/
    // node-pty trees won't perfectly match every file OpenAI's original
    // build shipped there (missing .bin symlinks, missing transient gyp
    // build-stamp files, etc.), and `asar extract` fails outright with
    // ENOENT hunting for files that simply don't exist in our rebuilt
    // tree. Running this step while app.asar.unpacked is still the
    // untouched, complete, DMG-sourced original avoids that entirely --
    // and it's safe to do so, because this step never touches
    // app.asar.unpacked itself, only app.asar. Do not move this block
    // below the "Rebuilding native modules" section.
    //
    // The bundle filename is a content hash that changes with every
    // OpenAI release (e.g. main-z6HVz-xR.js), so rather than hardcoding
    // it, we locate the right file inside .vite/build by searching for a
    // structural anchor string that sits immediately after the
    // `focusable` option in the shared window-creation code. If OpenAI
    // changes that surrounding code enough that the anchor no longer
    // matches, this step logs a warning and skips itself rather than
    // failing the whole build -- if you hit that warning on a future
    // version, the fix is to update ANCHOR/focusablePattern below to
    // match the new minified structure (re-run the diagnostic steps from
    // the session that found this bug: add a temporary console.log next
    // to any `focusable:` option in the extracted bundle and watch
    // isFocusable() in the app's focus-changed handler).
    console.log("Patching main-process bundle for focusable-window regression...");
    {
        const patchExtractDir = path.join(TEMP_DIR, 'asar_patch_extract');
        if (fs.existsSync(patchExtractDir)) {
            fs.rmSync(patchExtractDir, { recursive: true, force: true });
        }
        const targetAsarPath = path.join(targetResources, 'app.asar');

        try {
            execSync(`npx -y @electron/asar extract "${targetAsarPath}" "${patchExtractDir}"`, { stdio: 'inherit' });

            const ANCHOR = 'autoHideMenuBar:!0';
            const buildDir = path.join(patchExtractDir, '.vite', 'build');
            let targetFile = null;

            if (fs.existsSync(buildDir)) {
                const candidates = fs.readdirSync(buildDir).filter(f => f.endsWith('.js'));
                for (const f of candidates) {
                    const full = path.join(buildDir, f);
                    const content = fs.readFileSync(full, 'utf8');
                    if (content.includes(ANCHOR)) {
                        targetFile = full;
                        break;
                    }
                }
            }

            if (!targetFile) {
                console.warn("Could not locate main-process bundle to patch (no file under .vite/build contained");
                console.warn("the expected anchor string). Skipping focusable-window patch.");
                console.warn("If windows don't accept keyboard input after rebuilding, this bundle's structure");
                console.warn("has likely changed in a newer Codex release and the patch in rebuild_codex.js");
                console.warn("needs to be updated to match it -- see the comment above this block.");
            } else {
                let content = fs.readFileSync(targetFile, 'utf8');
                // Matches: focusable:<identifier>,...process.platform===`win32`||process.platform===`linux`?{autoHideMenuBar:!0}:{}
                // The identifier is whatever the minifier named the destructured
                // `focusable` parameter (e.g. `m`) -- captured generically so
                // renamed variables in future builds still match.
                const focusablePattern = /focusable:([a-zA-Z_$][\w$]*),(\.\.\.process\.platform===`win32`\|\|process\.platform===`linux`\?\{autoHideMenuBar:!0\}:\{\})/;
                const match = content.match(focusablePattern);

                if (!match) {
                    console.warn(`Found candidate bundle (${path.basename(targetFile)}) but the focusable-option`);
                    console.warn("pattern didn't match inside it. Skipping patch -- the minified structure has");
                    console.warn("likely shifted since this script was written; update focusablePattern above.");
                } else {
                    content = content.replace(focusablePattern, 'focusable:$1??!0,$2');
                    fs.writeFileSync(targetFile, content, 'utf8');
                    console.log(`Patched focusable option in ${path.basename(targetFile)} (variable was '${match[1]}').`);

                    fs.rmSync(targetAsarPath, { force: true });
                    execSync(`npx -y @electron/asar pack "${patchExtractDir}" "${targetAsarPath}"`, { stdio: 'inherit' });
                    console.log("Repacked app.asar with focusable patch applied.");
                }
            }
        } catch (e) {
            console.warn("Failed to apply focusable-window patch:", e.message);
            console.warn("The app should still build, but on the Electron 37.5.1 macOS-11 fallback the primary");
            console.warn("window may not accept keyboard focus (grey traffic lights, no typing). See session");
            console.warn("notes for the manual extract/patch/repack steps as a fallback.");
        } finally {
            if (fs.existsSync(patchExtractDir)) {
                fs.rmSync(patchExtractDir, { recursive: true, force: true });
            }
        }
    }

    // Fix Rebuild needed modules
    // ------------------------------------------------------------------
    // IMPORTANT: this rebuilds EVERY native (.node-containing) package
    // found anywhere under app.asar.unpacked, not just better-sqlite3/
    // node-pty. OpenAI's dependency tree ships several other native
    // addons (e.g. node-mac-permissions, objc-js, and transitively
    // nested modules like node-hid/serialport under scoped packages
    // such as @worklouder/...) -- every single one of them was compiled
    // for the ORIGINAL Electron version this app shipped with, and every
    // one needs rebuilding for whichever Electron version we actually
    // bundle. Leaving any of them un-rebuilt causes a NODE_MODULE_VERSION
    // mismatch at runtime -- this is exactly what caused a "Codex cannot
    // access its local database" dialog during development, even though
    // the actual failing module (node-mac-permissions) had nothing to do
    // with the database; the app's generic startup error handling just
    // misattributed the crash. Scanning for every native module rather
    // than hardcoding a list also means this keeps working automatically
    // if OpenAI adds or removes native dependencies in a future release.
    console.log("Scanning app.asar.unpacked for native (.node) packages to rebuild...");

    function findNativePackageDirs(rootDir) {
        const nodeModulesRoot = path.join(rootDir, 'node_modules');
        console.log(`[native-scan] rootDir=${rootDir}`);
        console.log(`[native-scan] nodeModulesRoot=${nodeModulesRoot}`);
        console.log(`[native-scan] nodeModulesRoot exists=${fs.existsSync(nodeModulesRoot)}`);
        if (!fs.existsSync(nodeModulesRoot)) return [];
        const findCmd = `find "${nodeModulesRoot}" -name "*.node" -type f`;
        console.log(`[native-scan] running: ${findCmd}`);
        let nodeFilesOutput;
        try {
            nodeFilesOutput = execSync(findCmd, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
        } catch (e) {
            console.warn("[native-scan] find command threw an error:", e.message);
            if (e.stdout) console.warn("[native-scan] partial stdout was:", e.stdout.toString().slice(0, 2000));
            if (e.stderr) console.warn("[native-scan] stderr was:", e.stderr.toString().slice(0, 2000));
            return [];
        }
        console.log(`[native-scan] raw output length=${nodeFilesOutput.length}`);
        console.log(`[native-scan] raw output (first 2000 chars):\n${nodeFilesOutput.slice(0, 2000)}`);
        const nodeFiles = nodeFilesOutput.split('\n').map(l => l.trim()).filter(Boolean);
        console.log(`[native-scan] parsed ${nodeFiles.length} .node file path(s)`);
        const packageRoots = new Set();
        for (const nodeFile of nodeFiles) {
            let dir = path.dirname(nodeFile);
            let found = false;
            while (dir.startsWith(rootDir)) {
                if (fs.existsSync(path.join(dir, 'package.json'))) {
                    packageRoots.add(dir);
                    found = true;
                    break;
                }
                const parent = path.dirname(dir);
                if (parent === dir) break;
                dir = parent;
            }
            if (!found) {
                console.warn(`[native-scan] could not find a package.json above: ${nodeFile}`);
            }
        }
        console.log(`[native-scan] identified ${packageRoots.size} unique package root(s)`);
        const results = [];
        for (const dir of packageRoots) {
            try {
                const ownPkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
                if (!ownPkg.name || !ownPkg.version) {
                    console.warn(`Skipping ${dir}: package.json missing name/version.`);
                    continue;
                }
                results.push({
                    dir,
                    relPath: path.relative(nodeModulesRoot, dir),
                    name: ownPkg.name,
                    version: ownPkg.version,
                });
            } catch (e) {
                console.warn(`Found native binary under a package at ${dir} but couldn't read its package.json:`, e.message);
            }
        }
        return results;
    }

    const nativePackages = findNativePackageDirs(targetUnpacked);
    if (nativePackages.length === 0) {
        console.warn("No native packages found under app.asar.unpacked -- this is unexpected, double-check the app still ships native modules.");
    } else {
        console.log(`Found ${nativePackages.length} native package(s) to rebuild for Electron ${electronVersion}:`);
        for (const p of nativePackages) {
            console.log(`  - ${p.name}@${p.version} (at node_modules/${p.relPath})`);
        }
    }

    const tempBuildDir = path.join(REPO_ROOT, 'native_build_temp');
    if (fs.existsSync(tempBuildDir)) {
        fs.rmSync(tempBuildDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tempBuildDir);

    const nativePkg = {
        "name": "temp-build",
        "dependencies": {}
    };
    for (const p of nativePackages) {
        nativePkg.dependencies[p.name] = p.version;
    }
    fs.writeFileSync(path.join(tempBuildDir, 'package.json'), JSON.stringify(nativePkg, null, 2));

    const env = {
        ...process.env,
        npm_config_target: electronVersion,
        npm_config_arch: 'x64',
        npm_config_target_arch: 'x64',
        npm_config_dist_url: 'https://electronjs.org/headers',
        npm_config_runtime: 'electron',
    };

    console.log("Installing native module sources (scripts disabled)...");
    try {
        execSync(`npm install --ignore-scripts`, { cwd: tempBuildDir, env, stdio: 'inherit' });
    } catch (e) {
        console.error("npm install failed:", e.message);
    }

    // Try prebuilt binaries first for each native module; only fall back to
    // node-gyp (source compile) if no prebuild exists for this Electron/arch/platform.
    for (const p of nativePackages) {
        const modDir = path.join(tempBuildDir, 'node_modules', p.name);
        if (!fs.existsSync(modDir)) {
            console.warn(`Skipping ${p.name}: not found in node_modules after install (fresh install of this exact name@version may have failed or resolved differently than expected).`);
            continue;
        }
        console.log(`Fetching prebuilt binary for ${p.name} (electron v${electronVersion}, darwin x64)...`);
        try {
            execSync(
                `npx prebuild-install --runtime=electron --target=${electronVersion} --arch=x64 --platform=darwin --verbose`,
                { cwd: modDir, env, stdio: 'inherit' }
            );
            console.log(`${p.name}: prebuilt binary installed successfully.`);
        } catch (e) {
            console.warn(`${p.name}: no prebuilt binary available, falling back to source build (node-gyp)...`);
            try {
                execSync(`npx node-gyp rebuild --release`, {
                    cwd: modDir,
                    env: {
                        ...env,
                        npm_config_build_from_source: 'true',
                        CXXFLAGS: '-std=c++20 -stdlib=libc++'
                    },
                    stdio: 'inherit'
                });
            } catch (e2) {
                console.error(`${p.name}: source build also failed. This module may not work in the final app.`);
            }
        }
    }

    // Copy each freshly-rebuilt module back into its EXACT original
    // location inside app.asar.unpacked (which may be deeply nested,
    // e.g. node_modules/@worklouder/device-kit-oai/node_modules/
    // @worklouder/wl-device-kit/node_modules/node-hid) -- not just a
    // shallow top-level node_modules/<name> path.
    for (const p of nativePackages) {
        const freshSrc = path.join(tempBuildDir, 'node_modules', p.name);
        const originalDest = path.join(targetUnpacked, 'node_modules', p.relPath);
        if (!fs.existsSync(freshSrc)) {
            console.warn(`Skipping copy-back for ${p.name}: no freshly-built module found (see warnings above).`);
            continue;
        }
        if (fs.existsSync(originalDest)) {
            fs.rmSync(originalDest, { recursive: true, force: true });
        }
        fs.mkdirSync(path.dirname(originalDest), { recursive: true });
        run(`cp -r "${freshSrc}" "${originalDest}"`);
    }

    console.log("Native modules updated.");
    // Config Info.plist and Executable
    console.log("Configuring Info.plist and Executable...");

    const infoPlistDest = path.join(targetApp, 'Contents/Info.plist');
    const localInfoPlist = path.join(RESOURCES_DIR, 'Info.plist');

    if (fs.existsSync(localInfoPlist)) {
        fs.copyFileSync(localInfoPlist, infoPlistDest);

        // The copied Info.plist came from the ORIGINAL app (built for
        // electronVersion as declared in package.json), so its
        // LSMinimumSystemVersion reflects that original version's OS
        // requirement -- even if we've since substituted an older,
        // more-compatible Electron binary above. Patch it to match
        // whatever Electron version we actually bundled.
        const finalElectronMajor = parseInt(electronVersion.split('.')[0], 10);
        let requiredMacOSVersion;
        if (finalElectronMajor >= 38) {
            requiredMacOSVersion = '12.0';
        } else if (finalElectronMajor >= 33) {
            requiredMacOSVersion = '11.0';
        } else {
            requiredMacOSVersion = '10.15';
        }
        try {
            execSync(`plutil -replace LSMinimumSystemVersion -string "${requiredMacOSVersion}" "${infoPlistDest}"`, { stdio: 'inherit' });
            console.log(`Set LSMinimumSystemVersion to ${requiredMacOSVersion} (matching bundled Electron ${electronVersion}).`);
        } catch (e) {
            console.warn("Could not patch LSMinimumSystemVersion:", e.message);
        }
    }

    const macOsDir = path.join(targetApp, 'Contents/MacOS');
    const electronBin = path.join(macOsDir, 'Electron');
    const codexOrigBin = path.join(macOsDir, 'Codex.orig');
    const codexWrapper = path.join(macOsDir, 'Codex');

    if (fs.existsSync(electronBin)) {
        // Rename the real binary to Codex.orig
        fs.renameSync(electronBin, codexOrigBin);

        // Create a wrapper script that launches with --no-sandbox
        const wrapperScript = `#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/Codex.orig" --no-sandbox "$@"
`;
        fs.writeFileSync(codexWrapper, wrapperScript);
        fs.chmodSync(codexWrapper, '755');
        console.log("Created --no-sandbox wrapper script at " + codexWrapper);
    } else {
        console.warn("Electron binary not found at checked path: " + electronBin);
    }

    // 7. Copy Codex Binary
    console.log("Copying Codex x64 binary...");

    // Dynamically find codex binary inside CLI path
    let sourceCodexBin = null;
    try {
        const findCodex = execSync(`find "${CODEX_CLI_PATH}" -name codex -type f | grep "x86_64" | head -n 1`, { encoding: 'utf8' }).trim();
        if (findCodex && fs.existsSync(findCodex)) {
            sourceCodexBin = findCodex;
        }
    } catch (e) {
        console.warn("Error searching for codex binary:", e.message);
    }

    if (sourceCodexBin) {
        const targetCodexBin = path.join(targetResources, 'codex');
        console.log(`Copying ${sourceCodexBin} to ${targetCodexBin}`);
        fs.copyFileSync(sourceCodexBin, targetCodexBin);
        fs.chmodSync(targetCodexBin, '755');

        const binDir = path.join(targetResources, 'bin');
        if (!fs.existsSync(binDir)) {
            fs.mkdirSync(binDir);
        }
        const targetBinCodex = path.join(binDir, 'codex');
        fs.copyFileSync(sourceCodexBin, targetBinCodex);
        fs.chmodSync(targetBinCodex, '755');

        // Copy rg (ripgrep)
        let sourceRgBin = null;
        try {
            // Find 'rg' binary inside CLI path, prioritize x86_64
            const findRg = execSync(`find "${CODEX_CLI_PATH}" -name rg -type f | grep "x86_64" | head -n 1`, { encoding: 'utf8' }).trim();
            if (findRg && fs.existsSync(findRg)) {
                sourceRgBin = findRg;
            }
        } catch (e) {
            console.warn("Error searching for rg binary:", e.message);
        }

        if (sourceRgBin) {
            const targetBinRg = path.join(binDir, 'rg');
            console.log(`Copying ${sourceRgBin} to ${targetBinRg}`);
            fs.copyFileSync(sourceRgBin, targetBinRg);
            fs.chmodSync(targetBinRg, '755');

            // Also copy to root resources if needed (mirroring codex behavior just in case)
            const targetRgResource = path.join(targetResources, 'rg');
            fs.copyFileSync(sourceRgBin, targetRgResource);
            fs.chmodSync(targetRgResource, '755');
        } else {
            console.warn(`WARNING: Could not find local x86_64 rg binary in ${CODEX_CLI_PATH}`);
        }

    } else {
        console.warn(`WARNING: Could not find local x64 Codex binary. Checked under: ${CODEX_CLI_PATH}`);
    }

    // 8. Fix Timestamps
    console.log("Fixing app timestamps...");
    run(`touch "${targetApp}"`);

    // Fix creation date using SetFile if available (macOS specific)
    try {
        const now = new Date();
        // Format: MM/DD/YYYY hh:mm:ss
        const p = (n) => n.toString().padStart(2, '0');
        const dateStr = `${p(now.getMonth() + 1)}/${p(now.getDate())}/${now.getFullYear()} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
        console.log(`Setting creation date to ${dateStr}...`);
        execSync(`SetFile -d "${dateStr}" "${targetApp}"`, { stdio: 'inherit' });
    } catch (e) {
        console.warn("SetFile failed or not available (this is normal on non-macOS or minimal envs). Creation date might be old.");
    }

    // 9. Clear quarantine and ad-hoc sign so Finder/LaunchServices will
    // actually launch this assembled app (mixed sources -- extracted DMG
    // content + freshly downloaded Electron -- commonly fail Finder's
    // launch checks even when the binary itself is fine).
    console.log("Clearing quarantine attribute and ad-hoc signing...");
    try {
        execSync(`xattr -cr "${targetApp}"`, { stdio: 'inherit' });
    } catch (e) {
        console.warn("Failed to clear quarantine attribute:", e.message);
    }
    try {
        execSync(`codesign --force --deep --sign - "${targetApp}"`, { stdio: 'inherit' });
    } catch (e) {
        console.warn("Ad-hoc code signing failed:", e.message);
    }

    // 10. Cleanup temp files
    console.log("Cleaning up temporary files...");
    for (const dir of [TEMP_DIR, tempBuildDir]) {
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
    // Remove extracted package.json
    const extractedPkgJson = path.join(REPO_ROOT, 'package.json');
    if (fs.existsSync(extractedPkgJson)) {
        fs.unlinkSync(extractedPkgJson);
    }

    console.log("Done! Codex_Intel.app is ready at " + targetApp);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
