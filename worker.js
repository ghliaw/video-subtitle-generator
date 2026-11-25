// SPDX-License-Identifier: GPL-2.0-or-later

/* The page starts this function in a Blob worker, including from file://. */
function subtitleWorkerMain() {
  'use strict';

  const sampleRate = 16000;
  const chunkSeconds = 300;
  const overlapSeconds = 2;
  const inputDirectory = '/videos';
  const audioPath = '/transcription.f32';
  const modelPath = '/whisper-model.bin';
  let ffmpeg;
  let whisper;
  let context;

  const report = (type, data = {}) => self.postMessage({ type, ...data });

  function unwrap(result) {
    if (!result?.ok) throw new Error(result?.error || '語音辨識引擎執行失敗。');
    return result;
  }

  async function initialize({ ffmpegWasm, whisperWasm, model }) {
    ffmpeg = await createFFmpegCore({ wasmBinary: ffmpegWasm });
    ffmpeg.FS.mkdir(inputDirectory);

    whisper = await createWhisperNodeModule({
      instantiateWasm(imports, receive) {
        const module = new WebAssembly.Module(whisperWasm);
        receive(new WebAssembly.Instance(module, imports));
      },
      print: () => {},
      printErr: () => {},
    });
    whisper.FS.writeFile(modelPath, model, { canOwn: true });
    try {
      context = unwrap(await whisper.__wasm_init_whisper(modelPath, false, false)).id;
    } finally {
      whisper.FS.unlink(modelPath);
    }
  }

  function engineFailure(error, stage) {
    if (!/Aborted\(|out of memory|memory access out of bounds/i.test(error.message)) return error;
    const retry = stage === '辨識語音' ? '請先改用標準模式重試。' : '請確認影片可正常播放並已完整儲存在本機。';
    return Object.assign(new Error(`離線引擎在${stage}時中止。${retry}若仍失敗，可將影片切成較短的檔案後處理。`), { fatal: true });
  }

  function probeDuration(input) {
    const output = [];
    ffmpeg.setLogger(({ type, message }) => {
      if (type === 'stdout') output.push(message);
    });
    try {
      const status = ffmpeg.ffprobe('-v', 'error', '-select_streams', 'a:0',
        '-show_entries', 'stream=start_time,duration:format=start_time,duration', '-of', 'json', input);
      if (status !== 0 || !output.length) return null;
      const { streams, format } = JSON.parse(output.join('\n'));
      const audio = streams?.[0];
      const length = Number(audio?.duration);
      if (Number.isFinite(length) && length > 0) {
        return length + Math.max(0, (Number(audio.start_time) || 0) - (Number(format?.start_time) || 0));
      }
      const fallback = Number(format?.duration);
      return Number.isFinite(fallback) && fallback > 0 ? fallback : null;
    } catch (error) {
      if (error instanceof SyntaxError) return null;
      throw engineFailure(error, '讀取影片');
    } finally {
      ffmpeg.reset();
    }
  }

  function decode(input, offset, length) {
    const fs = ffmpeg.FS;
    let errorLog = '';
    let abortLog = '';
    ffmpeg.setLogger(({ message }) => {
      if (/Aborted\(|out of memory/i.test(message)) abortLog = message;
      if (/matches no streams|invalid data|error|could not/i.test(message)) {
        errorLog = message;
      }
    });
    try {
      const seek = offset ? ['-ss', String(offset)] : [];
      const status = ffmpeg.exec('-hide_banner', '-nostats', '-loglevel', 'error',
        ...seek, '-i', input, '-t', String(length),
        '-map', '0:a:0', '-vn', '-sn', '-dn', '-af', 'aresample=async=1:first_pts=0',
        '-ac', '1', '-ar', String(sampleRate), '-c:a', 'pcm_f32le', '-f', 'f32le', audioPath);
      if (status !== 0) {
        if (status === -1 && abortLog) throw new Error(abortLog);
        const message = /matches no streams/i.test(errorLog)
          ? '影片沒有音軌。' : '無法解碼這段音訊。請確認影片完整，且音軌格式受到支援。';
        throw new Error(message);
      }
      if (!fs.analyzePath(audioPath).exists) return new Float32Array();
      const raw = fs.readFile(audioPath);
      return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / Float32Array.BYTES_PER_ELEMENT);
    } catch (error) {
      throw engineFailure(error, '解碼音訊');
    } finally {
      ffmpeg.reset();
      if (fs.analyzePath(audioPath).exists) fs.unlink(audioPath);
    }
  }

  async function recognize(audio, language, progress) {
    try {
      return unwrap(await whisper.__wasm_transcribe(context, audio, {
        language,
        translate: false,
        maxThreads: 1,
        onProgress: progress,
      }));
    } catch (error) {
      throw engineFailure(error, '辨識語音');
    }
  }

  async function transcribe(file, language) {
    const fs = ffmpeg.FS;
    const extension = file.name.match(/\.[a-z0-9]+$/i)?.[0] || '.mp4';
    const name = `source${extension}`;
    const input = `${inputDirectory}/${name}`;
    const segments = [];
    let detectedLanguage;
    let duration = 0;
    fs.mount(fs.filesystems.WORKERFS, { blobs: [{ name, data: file }] }, inputDirectory);
    try {
      report('progress', { stage: 'decode', part: 1 });
      const expectedDuration = probeDuration(input);
      for (let start = 0, part = 1; ; start += chunkSeconds, part++) {
        const end = start + chunkSeconds;
        const offset = Math.max(0, start - overlapSeconds);
        report('progress', { stage: 'decode', part });
        const audio = decode(input, offset, end + overlapSeconds - offset);
        const audioDuration = audio.length / sampleRate;
        if (audioDuration) duration = Math.max(duration, offset + audioDuration);
        const finished = offset + audioDuration <= end && !(expectedDuration > end);

        const firstAudible = audio.findIndex(sample => Math.abs(sample) > 0.0001);
        if (firstAudible >= 0) {
          // Long leading silence can make Whisper start the first cue at the chunk boundary.
          const firstSample = firstAudible >= sampleRate ? firstAudible - sampleRate / 4 : 0;
          const speech = audio.subarray(firstSample);
          const cueOffset = offset * 1000 + Math.round(firstSample * 1000 / sampleRate);
          const progress = percent => {
            const position = offset + (firstSample + speech.length * percent / 100) / sampleRate;
            const processed = Math.max(start, Math.min(position, end));
            report('progress', { stage: 'recognize', part,
              percent: expectedDuration ? 100 * processed / expectedDuration : percent });
          };
          progress(0);
          const result = await recognize(speech, detectedLanguage || language, progress);
          detectedLanguage = detectedLanguage || result.language;
          // Keep speech across boundaries while assigning each cue to one chunk.
          for (const segment of result.segments) {
            const t0 = Math.max(0, Number(segment.t0));
            const t1 = Math.min(Math.round(speech.length * 1000 / sampleRate), Number(segment.t1));
            const midpoint = (cueOffset + (t0 + t1) / 2) / 1000;
            if (t1 > t0 && midpoint >= start && (finished || midpoint < end)) {
              segments.push({ text: segment.text, t0: t0 + cueOffset, t1: t1 + cueOffset });
            }
          }
        }
        if (finished) break;
      }
      return { segments, duration, language: detectedLanguage };
    } finally {
      fs.unmount(inputDirectory);
    }
  }

  self.onmessage = async ({ data }) => {
    try {
      if (data.type === 'init') {
        await initialize(data);
        report('ready');
      } else if (data.type === 'transcribe') {
        report('result', await transcribe(data.file, data.language));
      }
    } catch (error) {
      report('failure', { message: error?.message || String(error), fatal: error?.fatal });
    }
  };
}
