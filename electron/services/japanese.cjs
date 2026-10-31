'use strict';
/**
 * Japanese reading helpers for matching a Spotify title against a YouTube upload written in a different script.
 *
 *   Spotify:  僕が死のうと思ったのは          YouTube:  Boku Ga Shinou To Omottanowa
 *   Spotify:  Mayonaka no Door               YouTube:  真夜中のドア
 *   Spotify:  ハルジオン (katakana)           YouTube:  はるじおん (hiragana)
 *
 * What it knows, with no dictionary and no dependencies:
 *   - hiragana, katakana (incl. half-width, ー, っ, ゃゅょ, ヴ, ファ/ティ-style digraphs) -> romaji
 *   - Latin text, which is already "readable"
 *   - kanji: it cannot know their reading without a ~40 MB dictionary, so each kanji is treated as an unknown stretch of
 *     sound ("gap") and the kana / Latin parts around it must still line up, in order, with the other title.
 *
 * Romanization is wildly inconsistent (shinou / shinō / shinoo, shi / si, wa / ha for は, ...), so both sides are reduced
 * to a coarse "phonetic key" and compared by approximate (edit-distance) matching rather than equality.
 */

const HAN_OR_HANGUL = /[\p{Script=Han}\p{Script=Hangul}]/u;
const RUNS = /[\p{Script=Han}\p{Script=Hangul}]+|[^\p{Script=Han}\p{Script=Hangul}]+/gu;

const BASE = {
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
  や: 'ya', ゆ: 'yu', よ: 'yo',
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
  わ: 'wa', ゐ: 'i', ゑ: 'e', を: 'o', ん: 'n',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
  ゔ: 'vu', ゕ: 'ka', ゖ: 'ke'
};
const SMALL_VOWEL = { ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o' };
const SMALL_Y = { ゃ: 'a', ゅ: 'u', ょ: 'o' };
const LARGE_FOR_SMALL = { ぁ: 'あ', ぃ: 'い', ぅ: 'う', ぇ: 'え', ぉ: 'お', ゃ: 'や', ゅ: 'ゆ', ょ: 'よ', ゎ: 'わ' };

/** Katakana -> hiragana, so カタカナ and ひらがな compare equal. Leaves ー (prolonged sound mark) alone. */
function foldKana(text) {
  let out = '';
  for (const ch of String(text || '')) {
    const code = ch.codePointAt(0);
    if (code >= 0x30a1 && code <= 0x30f6) out += String.fromCodePoint(code - 0x60);
    else if (ch === 'ヽ') out += 'ゝ';
    else out += ch;
  }
  return out;
}

const isKana = ch => /[\u3041-\u3096\u30fc]/.test(ch);

/** Hiragana / katakana -> Hepburn-style romaji. Everything that is not kana (Latin, digits, spaces) passes through untouched. */
function kanaToRomaji(input) {
  const text = foldKana(String(input || '').normalize('NFKC'));
  const chars = Array.from(text);
  let out = '';
  let doubleNext = false;
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (ch === 'っ') { doubleNext = true; continue; }
    if (ch === 'ー') { const last = out.match(/[aiueo]$/); if (last) out += last[0]; continue; }
    if (!BASE[ch] && !LARGE_FOR_SMALL[ch]) { doubleNext = false; out += ch; continue; }
    let syllable = BASE[ch] || BASE[LARGE_FOR_SMALL[ch]] || '';
    const next = chars[i + 1];
    if (BASE[ch] && next && SMALL_Y[next]) {
      const stem = syllable.slice(0, -1);
      syllable = /(sh|ch|j)$/.test(stem) ? stem + SMALL_Y[next] : `${stem}y${SMALL_Y[next]}`;
      i += 1;
    } else if (BASE[ch] && next && SMALL_VOWEL[next]) {
      const stem = ch === 'う' ? 'w' : syllable.slice(0, -1);
      syllable = (ch === 'ゔ' ? 'v' : stem) + SMALL_VOWEL[next];
      i += 1;
    }
    if (doubleNext && /^[bcdfghjklmnpqrstvwxyz]/.test(syllable)) syllable = syllable[0] + syllable;
    doubleNext = false;
    out += syllable;
  }
  return out;
}

/**
 * A deliberately coarse spelling-independent key for comparing romanizations: shi/si, chi/ti, tsu/tu, ji/zi, fu/hu,
 * ou/oo/ō -> o, doubled letters, wo/o, l/r, v/b all collapse. Both sides go through the same function, so what matters is
 * only that equal-sounding spellings end up equal.
 */
function phoneticKey(romaji) {
  return String(romaji || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z]/g, '')
    .replace(/sh/g, 's').replace(/ch/g, 't').replace(/ts/g, 't').replace(/dz/g, 'z').replace(/j/g, 'z')
    .replace(/f/g, 'h').replace(/v/g, 'b').replace(/l/g, 'r').replace(/wo/g, 'o').replace(/c(?=[aou])/g, 'k')
    .replace(/ou|oo/g, 'o').replace(/uu/g, 'u').replace(/aa/g, 'a').replace(/ii/g, 'i').replace(/ee|ei/g, 'e')
    .replace(/m(?=[bpm])/g, 'n')
    .replace(/([a-z])\1+/g, '$1');
}

/** Split a title into readable segments (kana -> romaji, Latin as is) separated by unreadable gaps (kanji / hangul). */
function readingSegments(text) {
  const segments = [];
  const pushRead = value => {
    const last = segments[segments.length - 1];
    if (last && last.type === 'read') last.text += value; else segments.push({ type: 'read', text: value });
  };
  const normalized = String(text || '').normalize('NFKC').toLowerCase();
  for (const run of normalized.match(RUNS) || []) {
    if (HAN_OR_HANGUL.test(run)) {
      const last = segments[segments.length - 1];
      const size = Array.from(run).length;
      if (last && last.type === 'gap') last.size += size; else segments.push({ type: 'gap', size });
    } else pushRead(kanaToRomaji(run));
  }
  for (const segment of segments) if (segment.type === 'read') segment.key = phoneticKey(segment.text);
  return segments.filter(segment => segment.type === 'gap' || segment.key);
}

const hasGap = segments => segments.some(segment => segment.type === 'gap');
const readKeyLength = segments => segments.reduce((sum, segment) => sum + (segment.key ? segment.key.length : 0), 0);

/** Best approximate occurrence of `needle` starting anywhere in [from, to] of `hay`: { start, end, dist } (or null). */
function bestFit(needle, hay, from, to) {
  let best = null;
  const m = needle.length;
  const maxLen = Math.ceil(m * 1.5) + 1;
  for (let start = Math.max(0, from); start <= Math.min(to, hay.length); start += 1) {
    let previous = Array.from({ length: maxLen + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i += 1) {
      const row = [i];
      for (let j = 1; j <= maxLen; j += 1) {
        const cost = needle[i - 1] === hay[start + j - 1] ? 0 : 1;
        row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + cost);
      }
      previous = row;
    }
    for (let j = 1; j <= maxLen && start + j <= hay.length; j += 1) {
      if (!best || previous[j] < best.dist || (previous[j] === best.dist && start < best.start)) best = { start, end: start + j, dist: previous[j] };
    }
  }
  return best;
}

const MIN_GAP_PER_KANJI = 1;
const MAX_GAP_PER_KANJI = 10; // a kanji is read with 1-4 syllables, i.e. up to ~10 letters ("shou", "kyou", "tsuki", "ryuu")

/**
 * How well does `other` (a title with no kanji) read like `jp` (kana / Latin with kanji as unknown gaps)?
 * Returns 0..1, or null when there is too little to compare (fewer than 4 readable letters, or `other` has kanji itself).
 */
function alignReading(jp, other) {
  const segments = readingSegments(jp);
  const otherSegments = readingSegments(other);
  if (hasGap(otherSegments)) return null;
  const total = readKeyLength(segments);
  if (total < 4) return null;
  const hay = otherSegments.map(segment => segment.key).join('');
  if (!hay) return null;

  const firstRead = segments.findIndex(segment => segment.type === 'read');
  const leadingGap = segments.slice(0, firstRead).reduce((sum, segment) => sum + segment.size, 0);
  const first = segments[firstRead];
  const cap = segment => Math.floor(segment.key.length * 0.34);

  let bestTotal = Infinity;
  let bestSpan = 0;
  for (let start = leadingGap * MIN_GAP_PER_KANJI; start <= hay.length; start += 1) {
    const head = bestFit(first.key, hay, start, start);
    if (!head || head.dist > cap(first)) continue;
    let dist = head.dist; let pos = head.end; let gapMin = 0; let gapMax = 0;
    for (let i = firstRead + 1; i < segments.length; i += 1) {
      const segment = segments[i];
      if (segment.type === 'gap') { gapMin += segment.size * MIN_GAP_PER_KANJI; gapMax += segment.size * MAX_GAP_PER_KANJI + 2; continue; }
      const fit = bestFit(segment.key, hay, pos + gapMin, pos + gapMax);
      if (fit && fit.dist <= cap(segment)) { dist += fit.dist; pos = fit.end; }
      else { dist += segment.key.length; pos += gapMin; }
      gapMin = 0; gapMax = 0;
    }
    if (dist < bestTotal) { bestTotal = dist; bestSpan = pos - head.start; }
    if (bestTotal === 0) break;
  }
  if (!Number.isFinite(bestTotal)) return 0;
  let similarity = Math.max(0, 1 - bestTotal / total);
  // With no kanji to absorb extra sound, a much longer title is probably a different song ("ai" vs "ai no uta").
  if (!hasGap(segments) && hay.length - bestSpan > total * 1.2 + 8) similarity -= 0.15;
  return Math.max(0, Math.min(1, similarity));
}

/**
 * Symmetric title/artist comparison across writing systems. Returns 0..1, or null when the two strings are in the same
 * script (nothing to translate) or there is not enough readable text to judge.
 */
function readingSimilarity(a, b) {
  const textA = String(a || ''); const textB = String(b || '');
  const japaneseA = /[\u3041-\u30ff\p{Script=Han}]/u.test(textA);
  const japaneseB = /[\u3041-\u30ff\p{Script=Han}]/u.test(textB);
  if (!japaneseA && !japaneseB) return null;
  const scores = [alignReading(textA, textB), alignReading(textB, textA)].filter(score => score !== null);
  return scores.length ? Math.max(...scores) : null;
}

/** A romaji search phrase for a title made only of kana / Latin (null when it contains kanji, which we cannot read). */
function romajiQuery(title) {
  const segments = readingSegments(title);
  if (!segments.length || hasGap(segments)) return null;
  const text = kanaToRomaji(String(title || '').normalize('NFKC')).replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return /[a-z]/i.test(text) && /[\u3041-\u30ff]/.test(String(title || '').normalize('NFKC')) ? text : null;
}

module.exports = { foldKana, isKana, kanaToRomaji, phoneticKey, readingSegments, alignReading, readingSimilarity, romajiQuery };
