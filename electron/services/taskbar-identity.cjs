/**
 * Keeps the Windows taskbar showing ONE FlickFetch icon.
 *
 * Windows groups a running window with a pinned icon by AppUserModelID. The portable build extracts itself and runs from a
 * temporary folder, so a shortcut pinned from FlickFetch.exe has no AppUserModelID and a different target than the running
 * process; Windows then shows the pinned icon AND a second, separate icon for the running window.
 *
 * Two fixes, both harmless when nothing needs fixing:
 *  1. applyWindowIdentity: tells Windows which exe to launch when this window is pinned or relaunched (the real portable
 *     exe, not the temp copy), so pinning the running window creates a correct shortcut.
 *  2. repairPinnedShortcuts: stamps the AppUserModelID onto an existing FlickFetch shortcut in the user's pinned-taskbar
 *     folder, so an icon pinned earlier groups with the running window from the next launch on.
 */
const fs = require('node:fs');
const path = require('node:path');

const APP_ID = 'com.regualos.flickfetch';
const DISPLAY_NAME = 'Flick Fetch';
const EXE_NAME = /^flickfetch.*\.exe$/i;

/** The exe the person launched: the portable file when present, otherwise the running program. */
function launcherPath(env = process.env, execPath = process.execPath) {
  return path.resolve(env.PORTABLE_EXECUTABLE_FILE || execPath);
}

/** True when a shortcut's target is this FlickFetch (same file, or any FlickFetch*.exe such as an updated/renamed copy). */
function isFlickFetchShortcut(link, launcher) {
  const target = String(link?.target || '').trim();
  if (!target) return false;
  const norm = value => path.win32.normalize(String(value)).toLowerCase();
  if (launcher && norm(target) === norm(launcher)) return true;
  return EXE_NAME.test(path.win32.basename(target));
}

function pinnedTaskbarDir(env = process.env) {
  return env.APPDATA ? path.join(env.APPDATA, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar') : '';
}

/** Returns the number of shortcuts updated. Never throws. */
function repairPinnedShortcuts({ shell, env = process.env, launcher = launcherPath(env), log = () => {}, fsImpl = fs } = {}) {
  let fixed = 0;
  try {
    const dir = pinnedTaskbarDir(env);
    if (!dir || !shell?.readShortcutLink || !shell?.writeShortcutLink || !fsImpl.existsSync(dir)) return 0;
    for (const name of fsImpl.readdirSync(dir)) {
      if (!/\.lnk$/i.test(name)) continue;
      const file = path.join(dir, name);
      try {
        const link = shell.readShortcutLink(file);
        if (!isFlickFetchShortcut(link, launcher) || link.appUserModelId === APP_ID) continue;
        if (shell.writeShortcutLink(file, 'update', { appUserModelId: APP_ID })) {
          fixed++;
          log('info', `Linked the pinned taskbar icon "${name}" to the running app so only one icon shows.`);
        }
      } catch (error) { log('warn', `Could not read the pinned shortcut ${name}: ${error.message}`); }
    }
  } catch (error) { log('warn', `Taskbar icon check skipped: ${error.message}`); }
  return fixed;
}

/** Gives a window the relaunch command/icon Windows uses when the person pins it. */
function applyWindowIdentity(win, { launcher = launcherPath() } = {}) {
  try {
    if (!win || win.isDestroyed() || typeof win.setAppDetails !== 'function') return false;
    win.setAppDetails({
      appId: APP_ID,
      appIconPath: launcher,
      appIconIndex: 0,
      relaunchCommand: `"${launcher}"`,
      relaunchDisplayName: DISPLAY_NAME
    });
    return true;
  } catch { return false; }
}

module.exports = { APP_ID, DISPLAY_NAME, launcherPath, isFlickFetchShortcut, pinnedTaskbarDir, repairPinnedShortcuts, applyWindowIdentity };
