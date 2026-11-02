const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { APP_ID, isFlickFetchShortcut, repairPinnedShortcuts, applyWindowIdentity, launcherPath, pinnedTaskbarDir } = require('../electron/services/taskbar-identity.cjs');

function pinnedFolder(links) {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-pins-'));
  const dir = pinnedTaskbarDir({ APPDATA: appData });
  fs.mkdirSync(dir, { recursive: true });
  for (const name of Object.keys(links)) fs.writeFileSync(path.join(dir, name), '');
  const written = [];
  const shell = {
    readShortcutLink: file => { const l = links[path.basename(file)]; if (!l) throw new Error('unreadable'); return l; },
    writeShortcutLink: (file, op, props) => { written.push({ name: path.basename(file), op, props }); return true; }
  };
  return { env: { APPDATA: appData }, shell, written };
}

test('portable launcher path prefers PORTABLE_EXECUTABLE_FILE over the temp copy', () => {
  assert.equal(launcherPath({ PORTABLE_EXECUTABLE_FILE: 'D:\\Apps\\FlickFetch.exe' }, 'C:\\Temp\\x\\FlickFetch.exe'), path.resolve('D:\\Apps\\FlickFetch.exe'));
  assert.equal(launcherPath({}, 'C:\\Programs\\FlickFetch\\FlickFetch.exe'), path.resolve('C:\\Programs\\FlickFetch\\FlickFetch.exe'));
});

test('only FlickFetch shortcuts are recognised', () => {
  assert.equal(isFlickFetchShortcut({ target: 'D:\\Apps\\FlickFetch.exe' }, 'D:\\Apps\\FlickFetch.exe'), true);
  assert.equal(isFlickFetchShortcut({ target: 'E:\\Old\\FlickFetch-2.1.1-x64-Portable.exe' }, 'D:\\Apps\\FlickFetch.exe'), true);
  assert.equal(isFlickFetchShortcut({ target: 'C:\\Program Files\\Google\\Chrome\\chrome.exe' }, 'D:\\Apps\\FlickFetch.exe'), false);
  assert.equal(isFlickFetchShortcut({ target: '' }, 'D:\\Apps\\FlickFetch.exe'), false);
});

test('a pinned FlickFetch shortcut without an app ID is linked; others are untouched', () => {
  const { env, shell, written } = pinnedFolder({
    'FlickFetch.lnk': { target: 'D:\\Apps\\FlickFetch.exe', appUserModelId: '' },
    'Chrome.lnk': { target: 'C:\\chrome.exe', appUserModelId: 'Chrome' },
    'Broken.lnk': null
  });
  const fixed = repairPinnedShortcuts({ shell, env, launcher: 'D:\\Apps\\FlickFetch.exe' });
  assert.equal(fixed, 1);
  assert.deepEqual(written, [{ name: 'FlickFetch.lnk', op: 'update', props: { appUserModelId: APP_ID } }]);
});

test('an already-linked shortcut is not rewritten, and a missing folder is fine', () => {
  const ok = pinnedFolder({ 'FlickFetch.lnk': { target: 'D:\\Apps\\FlickFetch.exe', appUserModelId: APP_ID } });
  assert.equal(repairPinnedShortcuts({ shell: ok.shell, env: ok.env, launcher: 'D:\\Apps\\FlickFetch.exe' }), 0);
  assert.equal(ok.written.length, 0);
  assert.equal(repairPinnedShortcuts({ shell: ok.shell, env: { APPDATA: path.join(os.tmpdir(), 'ff-missing-' + Date.now()) } }), 0);
  assert.equal(repairPinnedShortcuts({ shell: ok.shell, env: {} }), 0);
});

test('window identity points relaunch at the real exe and never throws', () => {
  let details;
  const win = { isDestroyed: () => false, setAppDetails: d => { details = d; } };
  assert.equal(applyWindowIdentity(win, { launcher: 'D:\\Apps\\Flick Fetch\\FlickFetch.exe' }), true);
  assert.equal(details.appId, APP_ID);
  assert.equal(details.relaunchCommand, '"D:\\Apps\\Flick Fetch\\FlickFetch.exe"');
  assert.equal(details.appIconPath, 'D:\\Apps\\Flick Fetch\\FlickFetch.exe');
  assert.equal(applyWindowIdentity({ isDestroyed: () => true }), false);
  assert.equal(applyWindowIdentity({ isDestroyed: () => false, setAppDetails() { throw new Error('x'); } }), false);
  assert.equal(applyWindowIdentity(null), false);
});
