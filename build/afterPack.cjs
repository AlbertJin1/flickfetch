// electron-builder afterPack hook: drop Electron runtime files FlickFetch never uses, before the exe is compressed.
//
// dxcompiler.dll (about 25 MB) is the DirectX shader compiler Chromium loads only for WebGPU. FlickFetch is a plain
// HTML/CSS/React UI with no WebGPU or WebGL, so nothing ever asks for it. Everything else in the runtime
// (d3dcompiler_47.dll, vk_swiftshader.dll, ffmpeg.dll, the GPU fallbacks) is kept on purpose so rendering still works on
// machines with weak or blocked graphics drivers.
const fs = require('node:fs');
const path = require('node:path');

const UNUSED = ['dxcompiler.dll'];

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  let saved = 0;
  for (const name of UNUSED) {
    const file = path.join(context.appOutDir, name);
    try {
      const { size } = fs.statSync(file);
      fs.rmSync(file, { force: true });
      saved += size;
      console.log(`  • afterPack: removed unused ${name} (${(size / 1048576).toFixed(1)} MB)`);
    } catch { /* already absent in this Electron version */ }
  }
  if (saved) console.log(`  • afterPack: ${(saved / 1048576).toFixed(1)} MB removed before compression`);
};
