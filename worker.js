// SPDX-License-Identifier: GPL-2.0-or-later

/* The page starts this function in a Blob worker, including from file://. */
function subtitleWorkerMain() {
  'use strict';

  const sampleRate = 16000;
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

  function decode(file) {
    const fs = ffmpeg.FS;
    const extension = file.name.match(/\.[a-z0-9]+$/i)?.[0] || '.mp4';
    const name = `source${extension}`;
    let errorLog = '';
    ffmpeg.setLogger(({ message }) => {
      if (/matches no streams|invalid data|error|could not/i.test(message)) errorLog = message;
    });
    fs.mount(fs.filesystems.WORKERFS, { blobs: [{ name, data: file }] }, inputDirectory);
    try {
      ffmpeg.exec('-hide_banner', '-nostats', '-i', `${inputDirectory}/${name}`,
        '-map', '0:a:0', '-vn', '-sn', '-dn', '-af', 'aresample=async=1:first_pts=0',
        '-ac', '1', '-ar', String(sampleRate), '-c:a', 'pcm_f32le', '-f', 'f32le', audioPath);
      if (ffmpeg.ret !== 0) {
        const message = /matches no streams/i.test(errorLog)
          ? '影片沒有音軌。' : '無法解碼音訊。請確認影片完整，且音軌格式受到支援。';
        throw new Error(message);
      }
      const raw = fs.readFile(audioPath);
      return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / Float32Array.BYTES_PER_ELEMENT);
    } finally {
      ffmpeg.reset();
      if (fs.analyzePath(audioPath).exists) fs.unlink(audioPath);
      fs.unmount(inputDirectory);
    }
  }

  async function transcribe(file, language) {
    report('progress', { stage: 'decode' });
    const audio = decode(file);
    if (!audio.some(sample => Math.abs(sample) > 0.0001)) {
      return { segments: [], duration: audio.length / sampleRate };
    }
    report('progress', { stage: 'recognize', percent: 0 });
    const result = unwrap(await whisper.__wasm_transcribe(context, audio, {
      language,
      translate: false,
      maxThreads: 1,
      onProgress: percent => report('progress', { stage: 'recognize', percent }),
    }));
    return { segments: result.segments, duration: audio.length / sampleRate, language: result.language };
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
      report('failure', { message: error?.message || String(error) });
    }
  };
}
