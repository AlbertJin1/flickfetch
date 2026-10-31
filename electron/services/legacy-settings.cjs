function decodeLegacyValue(value) {
  let output = '';
  for (let index = 0; index < value.length; index++) {
    if (value[index] === '\\' && index + 1 < value.length) {
      index++;
      output += value[index] === 'n' ? '\n' : value[index];
    } else output += value[index];
  }
  return output;
}

function parseLegacySettings(source, defaults) {
  const defaultsByKey = new Map(Object.keys(defaults).map(key => [key.toLowerCase(), key]));
  const parsed = {};
  for (const line of String(source || '').split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = defaultsByKey.get(line.slice(0, separator).trim().toLowerCase());
    if (!key) continue;
    const raw = decodeLegacyValue(line.slice(separator + 1));
    const fallback = defaults[key];
    if (typeof fallback === 'boolean') {
      if (/^(true|false)$/i.test(raw.trim())) parsed[key] = raw.trim().toLowerCase() === 'true';
    } else if (typeof fallback === 'number') {
      const value = Number(raw.trim());
      if (Number.isFinite(value)) parsed[key] = value;
    } else if (typeof fallback === 'string') parsed[key] = raw;
  }
  return parsed;
}

module.exports = { parseLegacySettings };
