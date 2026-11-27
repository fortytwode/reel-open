const STOPWORDS = new Set(`
  a an the and or but so of to in on for with at by from is are was were be been being it its it's
  this that these those i i'm you we they he she my your our their me us them as if then than just
  like um uh okay ok yeah right really very can will would could should do does did have has had not no yes
  there here what which who how when where why all some any about into out up down over also going gonna get got
  let's let now know think want see look one two thing things kind sort lot bit actually basically hey hi hello
  everyone guys today go we're you're they're that's there's don't can't it'll i'll we'll you'll 's
`.trim().split(/\s+/u));
const FILLER_OPENERS = ['so ', 'okay ', 'ok ', 'um ', 'uh ', 'alright ', 'all right ', 'hey ', 'hi ', 'hello ', 'and ', 'yeah ', 'right '];
const MAX_SEGMENTS = 50_000;
const MAX_TRANSCRIPT_CHARS = 500_000;
const noSummary = () => ({ suggestedTitle: null, summary: null, chapters: [] });

function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  let text = value.replace(/\s+/gu, ' ').trim().replace(/^["“”'*#]+|["“”'*#]+$/gu, '').trim();
  if ([...text].length < 3) return null;
  const chars = [...text];
  if (chars.length > max) text = chars.slice(0, max - 1).join('').trimEnd() + '…';
  return text;
}

function words(text) { return text.toLowerCase().match(/[\p{L}\p{N}'’]+/gu) ?? []; }

function sentences(segments) {
  const result = [];
  for (const segment of segments) {
    let current = '';
    for (const character of segment.text) {
      current += character;
      if ('.?!'.includes(character)) {
        const sentence = current.trim();
        if (sentence) result.push({ start: segment.start, text: sentence });
        current = '';
      }
    }
    const sentence = current.trim();
    if (sentence) result.push({ start: segment.start, text: sentence });
  }
  return result;
}

function stripFiller(value) {
  let text = value.trim(), changed = true;
  while (changed) {
    changed = false;
    for (const filler of FILLER_OPENERS) {
      if (text.toLowerCase().startsWith(filler)) {
        text = text.slice(filler.length).trim().replace(/^[ ,]+/u, '');
        changed = true;
      }
    }
  }
  return text;
}

function headline(value, maxWords) {
  const text = stripFiller(value).replace(/^[.?!,; ]+|[.?!,; ]+$/gu, '');
  const split = text.split(/\s+/u).filter(Boolean);
  if (split.length < 2) return null;
  let title = split.slice(0, maxWords).join(' ');
  if (split.length > maxWords) title += '…';
  const chars = [...title];
  chars[0] = chars[0].toUpperCase();
  return chars.join('');
}

function chapters(segments, duration) {
  if (duration < 90 || segments.length < 4) return [];
  const count = Math.min(8, Math.max(2, Math.floor(duration / 120 + 0.5)));
  const interval = duration / count, starts = [0];
  for (let chapter = 1; chapter < count; chapter++) {
    const target = interval * chapter;
    let best = null;
    for (let i = 1; i < segments.length; i++) {
      const segment = segments[i];
      if (Math.abs(segment.start - target) > interval * 0.4 || i <= starts.at(-1)) continue;
      const gap = segment.start - segments[i - 1].end;
      if (best === null || gap > best.gap) best = { index: i, gap };
    }
    if (best) starts.push(best.index);
  }
  const result = [];
  for (const index of starts) {
    const title = headline(segments[index].text, 6);
    if (title) result.push({ start: index === 0 ? 0 : segments[index].start, title });
  }
  return result;
}

/** Deterministic extractive counterpart of Mac's fallback; this is not AI-generated. */
export function summarizeLocally(segments, duration) {
  if (!Array.isArray(segments) || !Number.isFinite(duration) || duration < 0) {
    throw Error('Local summary input is invalid.');
  }
  if (segments.length > MAX_SEGMENTS) return noSummary();
  let totalChars = 0;
  const safeSegments = [];
  for (const segment of segments) {
    if (typeof segment?.text !== 'string' || !Number.isFinite(segment.start) || !Number.isFinite(segment.end)
      || segment.start < 0 || segment.end < segment.start || segment.start > duration) continue;
    totalChars += [...segment.text].length;
    if (totalChars > MAX_TRANSCRIPT_CHARS) return noSummary();
    const text = segment.text.trim();
    if (text) safeSegments.push({ start: segment.start, end: Math.min(duration, segment.end), text });
  }
  const items = sentences(safeSegments);
  if (!items.length) return noSummary();

  const frequency = new Map();
  for (const item of items) {
    for (const word of words(item.text)) if (!STOPWORDS.has(word) && [...word].length > 2) {
      frequency.set(word, (frequency.get(word) ?? 0) + 1);
    }
  }
  const score = text => {
    const tokens = words(text);
    if (tokens.length < 4) return 0;
    const sum = tokens.reduce((total, word) => total + (STOPWORDS.has(word) ? 0 : (frequency.get(word) ?? 0)), 0);
    return sum / Math.sqrt(tokens.length);
  };
  const titleSource = items.slice(0, 4).reduce((best, item) => score(item.text) > score(best.text) ? item : best, items[0]);
  const suggestedTitle = cleanText(headline(titleSource.text, 9), 90);
  const ranked = items.map((item, index) => ({ index, score: score(item.text) }))
    .sort((left, right) => right.score - left.score || left.index - right.index).slice(0, 3)
    .map(item => item.index).sort((left, right) => left - right);
  let summary = '';
  for (const index of ranked) {
    const text = stripFiller(items[index].text), sentence = [...text].map((char, i) => i === 0 ? char.toUpperCase() : char).join('');
    if ([...summary].length + [...sentence].length > 420) break;
    summary += (summary ? ' ' : '') + sentence;
  }
  summary = [...summary].length < 10 ? null : cleanText(summary, 700);

  const safeChapters = chapters(safeSegments, duration).sort((left, right) => left.start - right.start)
    .reduce((result, chapter) => {
      const title = cleanText(chapter.title, 60);
      if (!Number.isFinite(chapter.start) || chapter.start < 0 || chapter.start >= Math.max(duration, 0.01) || !title
        || (result.length && chapter.start - result.at(-1).start < 20)) return result;
      result.push({ start: Math.round(chapter.start * 10) / 10, title });
      return result;
    }, []);
  if (safeChapters.length < 2) safeChapters.length = 0;
  else safeChapters[0].start = 0;
  return { suggestedTitle, summary, chapters: safeChapters };
}
