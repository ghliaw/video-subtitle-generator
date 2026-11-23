// SPDX-License-Identifier: GPL-2.0-or-later

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sources = [
  ['ffmpeg-wasm', 'ffmpegwasm/ffmpeg.wasm', 'v12.15', '71aa99d37c02a7b4c435275ca9ef50e612f6efa1'],
  ['ffmpeg', 'FFmpeg/FFmpeg', 'n5.1.4', '4729204c17f756e186d622060088371d10b34f7e'],
  ['x264', 'ffmpegwasm/x264', '4-cores', '33cac6b77d5b9259c552156013a817ab23119612'],
  ['x265', 'ffmpegwasm/x265', '3.4', '2bb5520e9596f361bf0ed81b3b8da0d7fd999069'],
  ['libvpx', 'ffmpegwasm/libvpx', 'v1.13.1', '10b9492dcf05b652e2e4b370e205bd605d421972'],
  ['lame', 'ffmpegwasm/lame', 'master', '2badea1974ae36cb8312afe99cff1e6b3b5decee'],
  ['ogg', 'ffmpegwasm/Ogg', 'v1.3.4', 'bada45718453ac27b56773ae663f7e65112f6a6e'],
  ['theora', 'ffmpegwasm/theora', 'v1.1.1', '7ffd8b2ecfc2d93ae5e16028e7528e609266bfbf'],
  ['opus', 'ffmpegwasm/opus', 'v1.3.1', 'e85ed7726db5d677c9c0677298ea0cb9c65bdd23'],
  ['vorbis', 'ffmpegwasm/vorbis', 'v1.3.3', '7798164043197d7e33f02de4353ce2aa5b248225'],
  ['zlib', 'ffmpegwasm/zlib', 'v1.2.11', 'cacf7f1d4e3d44d871b605da3b647f07d718623f'],
  ['libwebp', 'ffmpegwasm/libwebp', 'v1.3.2', 'ca332209cb5567c9b249c86788cb2dbf8847e760'],
  ['freetype2', 'ffmpegwasm/freetype2', 'VER-2-10-4', '6a2b3e4007e794bfc6c91030d0ed987f925164a8'],
  ['fribidi', 'fribidi/fribidi', 'v1.0.9', 'f9e8e71a6fbf4a4619481284c9f484d10e559995'],
  ['harfbuzz', 'harfbuzz/harfbuzz', '5.2.0', '4a1d891c6317d2c83e5f3c2607ec5f5ccedffcde'],
  ['libass', 'libass/libass', '0.15.0', 'd149636f502f5774ae1a8fb4c554b122674393b2'],
  ['zimg', 'sekrit-twc/zimg', 'release-3.0.5', 'e5b0de6bebbcbc66732ed5afaafef6b2c7dfef87'],
  ['zimg-test-googletest', 'google/googletest', 'zimg test submodule', '703bd9caab50b139428cea1aaff9974ebee5742e'],
  ['emscripten', 'emscripten-core/emscripten', '3.1.40', '5c27e79dd0a9c4e27ef2326841698cdd4f6b5784'],
  ['sdl2', 'libsdl-org/SDL', 'release-2.24.2', '55b03c7493a7abed33cf803d1380a40fa8af903f'],
];

const directory = await mkdtemp(join(tmpdir(), 'subtitle-ffmpeg-src-'));
const output = fileURLToPath(new URL('ffmpeg-core-0.12.10-source.tar', import.meta.url));
const reusableSources = process.argv[2];

async function fetchArchive(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(55_000) });
      if (!response.ok) throw new Error(`${response.status}: ${url}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (attempt === 3) throw error;
      console.warn(`Retrying ${url}: ${error.message}`);
    }
  }
}

async function downloadSource([name, repository, upstreamRef, revision]) {
  const filename = `${name}.tar.gz`;
  const url = `https://codeload.github.com/${repository}/tar.gz/${revision}`;
  const existing = reusableSources && await readFile(join(reusableSources, filename)).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  const archive = existing || await fetchArchive(url);
  const path = join(directory, filename);
  await writeFile(path, archive);
  const names = execFileSync('tar', ['-tf', path], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (!names.split(/\r?\n/, 1)[0].endsWith(`-${revision}/`)) {
    throw new Error(`Archive root does not match revision: ${filename}`);
  }
  console.log(`${filename} (${archive.length} bytes)`);
  return { filename, repository, upstreamRef, revision, url, sha256: createHash('sha256').update(archive).digest('hex') };
}

try {
  const manifest = [];
  for (let start = 0; start < sources.length; start += 5) {
    const results = await Promise.allSettled(sources.slice(start, start + 5).map(downloadSource));
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
      manifest.push(result.value);
    }
  }
  await writeFile(join(directory, 'sources.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await copyFile(new URL('./README.md', import.meta.url), join(directory, 'README.md'));
  const entries = ['README.md', 'sources.json', ...manifest.map(source => source.filename)];
  execFileSync('tar', ['-cf', output, '-C', directory, ...entries], { stdio: 'inherit' });
} finally {
  for (const [name] of sources) await rm(join(directory, `${name}.tar.gz`), { force: true });
  for (const name of ['README.md', 'sources.json']) await rm(join(directory, name), { force: true });
  await rmdir(directory);
}
