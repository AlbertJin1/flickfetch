'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SAVE_DELAY_MS = 400;
// A restored window must keep at least this much of its top-left area on a display so the title bar stays reachable.
const MIN_VISIBLE_W = 120;
const MIN_VISIBLE_H = 60;

function isFiniteNumber(value) { return typeof value === 'number' && Number.isFinite(value); }

function overlap(bounds, area) {
  const w = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
  const h = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
  return { w, h };
}

/**
 * Turns whatever was stored on disk into safe window options.
 * - Size is clamped to the minimum and to the largest connected display.
 * - Position is dropped (the OS/centering decides) if the window would be off-screen,
 *   for example when a secondary monitor was unplugged or the resolution changed.
 */
function sanitizeState(raw, { defaults, minWidth = 0, minHeight = 0, displays = [] }) {
  const state = { width: defaults.width, height: defaults.height, maximized: false };
  if (!raw || typeof raw !== 'object') return state;

  const areas = displays.map(d => d.workArea || d.bounds).filter(Boolean);
  const maxW = areas.length ? Math.max(...areas.map(a => a.width)) : Infinity;
  const maxH = areas.length ? Math.max(...areas.map(a => a.height)) : Infinity;

  if (isFiniteNumber(raw.width) && isFiniteNumber(raw.height)) {
    state.width = Math.round(Math.min(Math.max(raw.width, minWidth), maxW));
    state.height = Math.round(Math.min(Math.max(raw.height, minHeight), maxH));
  }

  if (isFiniteNumber(raw.x) && isFiniteNumber(raw.y)) {
    const candidate = { x: Math.round(raw.x), y: Math.round(raw.y), width: state.width, height: state.height };
    const visible = !areas.length || areas.some(area => {
      const { w, h } = overlap(candidate, area);
      return w >= Math.min(MIN_VISIBLE_W, candidate.width) && h >= Math.min(MIN_VISIBLE_H, candidate.height);
    });
    if (visible) { state.x = candidate.x; state.y = candidate.y; }
  }

  state.maximized = raw.maximized === true;
  return state;
}

function readStateFile(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

function writeStateFile(filePath, state) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, filePath);
  } catch { /* Remembering window size is a convenience; never block the app on it. */ }
}

function loadWindowState(filePath, options) {
  return sanitizeState(readStateFile(filePath), options);
}

/**
 * Keeps window-state.json up to date for a BrowserWindow.
 * Call after the window is created; the maximized flag is applied by the caller via the returned initial state.
 */
function trackWindowState(win, filePath, initial) {
  let last = { ...initial };
  let timer = null;

  const capture = () => {
    if (win.isDestroyed()) return;
    // Don't overwrite the remembered size with minimized/full-screen geometry.
    if (win.isMinimized() || win.isFullScreen()) return;
    // getNormalBounds returns the restored size even while the window is maximized.
    const bounds = win.getNormalBounds();
    last = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, maximized: win.isMaximized() };
  };
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    capture();
    writeStateFile(filePath, last);
  };
  const schedule = () => {
    capture();
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, SAVE_DELAY_MS);
  };

  for (const event of ['resize', 'move', 'maximize', 'unmaximize']) win.on(event, schedule);
  win.on('close', flush);
  return { flush };
}

module.exports = { sanitizeState, loadWindowState, trackWindowState };
