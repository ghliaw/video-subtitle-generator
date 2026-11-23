'use strict';

const Subtitle = (() => {
  const encoder = new TextEncoder();
  const extension = /\.[^.]+$/;

  function outputName(videoName) {
    return `${videoName.replace(extension, '') || videoName}.srt`;
  }

  function timestamp(ms) {
    const two = n => String(n).padStart(2, '0');
    return `${two(Math.floor(ms / 3600000))}:${two(Math.floor(ms / 60000) % 60)}:` +
      `${two(Math.floor(ms / 1000) % 60)},${String(ms % 1000).padStart(3, '0')}`;
  }

  function toSrt(segments, duration) {
    const limit = Math.floor(duration * 1000);
    // Embind exposes Whisper's int64 timestamps as BigInt in recent WASM builds.
    return segments.map(segment => ({ t0: Number(segment.t0), t1: Number(segment.t1), text: segment.text }))
      .filter(segment => Number.isFinite(segment.t0) && Number.isFinite(segment.t1))
      .sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1)
      .flatMap(segment => {
        const start = Math.max(0, Math.round(segment.t0));
        const stop = Math.min(limit, Math.round(segment.t1));
        const text = segment.text.replace(/\s+/gu, ' ').trim();
        return text && stop > start ? [{ start, stop, text }] : [];
      })
      .map(({ start, stop, text }, i) => `${i + 1}\n${timestamp(start)} --> ${timestamp(stop)}\n${text}\n\n`)
      .join('');
  }

  // Stored ZIP entries retain UTF-8 filenames and the selected folder structure.
  function makeZip(items) {
    if (items.length > 65535) throw new Error('ZIP 一次最多可匯出 65,535 個字幕。');
    const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
      for (let bit = 0; bit < 8; bit++) i = (i >>> 1) ^ ((i & 1) ? 0xedb88320 : 0);
      return i;
    });
    const header = (size, magic) => {
      const view = new DataView(new ArrayBuffer(size));
      view.setUint32(0, magic, true);
      return view;
    };
    const addMetadata = (view, at, crc, size, nameLength) => {
      view.setUint16(at, 20, true);
      view.setUint16(at + 2, 0x0800, true);
      view.setUint16(at + 8, 0x21, true); // 1980-01-01 (DOS date)
      view.setUint32(at + 10, crc, true);
      view.setUint32(at + 14, size, true);
      view.setUint32(at + 18, size, true);
      view.setUint16(at + 22, nameLength, true);
    };

    const localParts = [];
    const centralParts = [];
    const paths = new Set();
    let offset = 0;
    let centralSize = 0;
    for (const { path, name, srt } of items) {
      const folder = path.slice(0, path.lastIndexOf('/') + 1);
      let entry = folder + name;
      for (let duplicate = 2; paths.has(entry.toLowerCase()); duplicate++) {
        entry = `${folder}${name.slice(0, -4)} (${duplicate}).srt`;
      }
      paths.add(entry.toLowerCase());
      const filename = encoder.encode(entry);
      const contents = encoder.encode(srt);
      let crc = 0xffffffff;
      for (const byte of contents) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
      crc = (crc ^ 0xffffffff) >>> 0;

      const local = header(30, 0x04034b50);
      const central = header(46, 0x02014b50);
      addMetadata(local, 4, crc, contents.length, filename.length);
      central.setUint16(4, 20, true);
      addMetadata(central, 6, crc, contents.length, filename.length);
      central.setUint32(42, offset, true);
      localParts.push(local.buffer, filename, contents);
      centralParts.push(central.buffer, filename);
      offset += 30 + filename.length + contents.length;
      centralSize += 46 + filename.length;
    }
    if (offset + centralSize > 0xffffffff) throw new Error('匯出的字幕超過 ZIP 大小上限。');
    const end = header(22, 0x06054b50);
    end.setUint16(8, items.length, true);
    end.setUint16(10, items.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...localParts, ...centralParts, end.buffer], { type: 'application/zip' });
  }

  return { outputName, toSrt, makeZip };
})();
