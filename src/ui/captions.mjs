function plainText(value) { return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim(); }

function captionChunks(text, lineWidth = 38) {
  const words = plainText(text).split(' ').filter(Boolean);
  const lines = []; let line = '';
  for (const word of words) {
    if (line && `${line} ${word}`.length > lineWidth) { lines.push(line); line = ''; }
    if (word.length > lineWidth) {
      if (line) { lines.push(line); line = ''; }
      for (let start = 0; start < word.length; start += lineWidth) lines.push(word.slice(start, start + lineWidth));
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  const chunks = [];
  for (let i = 0; i < lines.length; i += 2) chunks.push(lines.slice(i, i + 2));
  return chunks;
}

export function subtitleCues(segments, clip) {
  const cues = [];
  for (const segment of segments) {
    if (!(segment.end > clip.start && segment.start < clip.end)) continue;
    const start = Math.max(segment.start, clip.start) - clip.start;
    const end = Math.min(segment.end, clip.end) - clip.start;
    if (!(Number.isFinite(start) && Number.isFinite(end) && end > start)) continue;
    const edited = Object.hasOwn(clip.captionEdits ?? {}, segment.id) ? clip.captionEdits[segment.id] : segment.text;
    const chunks = captionChunks(edited);
    const total = chunks.reduce((sum, lines) => sum + lines.join(' ').length, 0);
    let weight = 0;
    for (const lines of chunks) {
      const before = weight; weight += lines.join(' ').length;
      cues.push({ start: start + (end - start) * before / total, end: start + (end - start) * weight / total, lines, segmentId: segment.id });
    }
  }
  return cues;
}
