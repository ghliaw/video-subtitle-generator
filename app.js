// SPDX-License-Identifier: GPL-2.0-or-later

'use strict';

const OfflineAssets = (() => {
  const receivers = new Map();
  function load(id, signal) {
    let cleanup;
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const fail = message => reject(new Error(message));
      const cancel = () => reject(signal.reason);
      receivers.set(id, chunks => {
        if (document.currentScript !== script) return;
        try {
          const parts = chunks.map(chunk => {
            if (Uint8Array.fromBase64) return Uint8Array.fromBase64(chunk);
            return Uint8Array.from(atob(chunk), char => char.charCodeAt(0));
          });
          const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
          let offset = 0;
          for (const part of parts) {
            bytes.set(part, offset);
            offset += part.length;
          }
          resolve(bytes);
        } catch (error) {
          reject(error);
        }
      });
      script.src = `vendor/${id}.js`;
      script.onerror = () => fail(`找不到離線元件 ${id}。請確認 vendor 資料夾與 index.html 位於同一層。`);
      script.onload = () => fail(`無法讀取離線元件 ${id}。`);
      signal.addEventListener('abort', cancel, { once: true });
      cleanup = () => {
        receivers.delete(id);
        signal.removeEventListener('abort', cancel);
        script.remove();
      };
      document.head.append(script);
    }).finally(() => cleanup?.());
  }
  return { load, receive: (id, chunks) => receivers.get(id)?.(chunks) };
})();

(() => {
  const $ = id => document.getElementById(id);
  const ui = Object.fromEntries(['choose-file', 'choose-folder', 'file-input', 'folder-input',
    'dropzone', 'language', 'summary', 'clear', 'empty', 'queue', 'message', 'download-all',
    'stop', 'start'].map(id => [id, $(id)]));
  const extensions = /\.(mp4|m4v|mov|mkv|webm|avi|mpeg|mpg|ts|mts|m2ts|flv|wmv|3gp|ogv)$/i;
  const jobs = [];
  const keys = new Set();
  const displayLanguage = new Intl.DisplayNames(['zh-Hant'], { type: 'language' });
  let run;

  function download(blob, name) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
  }

  function makeRow(job) {
    const row = document.createElement('li');
    const info = document.createElement('div');
    const title = document.createElement('p');
    const detail = document.createElement('p');
    const progress = document.createElement('progress');
    const button = document.createElement('button');
    info.className = 'file-info';
    title.className = 'filename';
    title.textContent = job.path;
    detail.className = 'detail';
    progress.max = 100;
    progress.setAttribute('aria-label', `${job.file.name} 轉錄進度`);
    button.type = 'button';
    button.textContent = '下載 SRT';
    button.setAttribute('aria-label', `下載 ${job.name}`);
    button.onclick = () => download(new Blob([job.srt], { type: 'text/plain;charset=utf-8' }), job.name);
    info.append(title, detail, progress);
    row.append(info, button);
    job.view = { detail, progress, button };
    paintJob(job);
    return row;
  }

  function paintJob(job) {
    const { detail, progress, button } = job.view;
    detail.textContent = job.detail;
    detail.classList.toggle('error', job.state === 'failed');
    button.hidden = job.state !== 'done';
    progress.hidden = job.state !== 'working';
    if (job.percent == null) progress.removeAttribute('value');
    else progress.value = job.percent;
  }

  function refreshControls() {
    const done = jobs.filter(job => job.state === 'done').length;
    const skipped = jobs.filter(job => job.state === 'empty').length;
    const failed = jobs.filter(job => job.state === 'failed').length;
    const busy = Boolean(run);
    ui.summary.textContent = jobs.length ? [`${jobs.length} 部影片`, `${done} 部已完成`,
      skipped && `${skipped} 部無字幕`, failed && `${failed} 部失敗`].filter(Boolean).join(' · ') : '尚未加入影片';
    ui.empty.hidden = Boolean(jobs.length);
    ui['choose-file'].disabled = ui['choose-folder'].disabled = ui.language.disabled = busy;
    ui.clear.disabled = busy || !jobs.length;
    ui.start.hidden = busy;
    ui.start.disabled = !jobs.some(job => ['queued', 'failed', 'stopped'].includes(job.state));
    ui.start.textContent = failed && !jobs.some(job => ['queued', 'stopped'].includes(job.state))
      ? '重試失敗影片' : '開始產生字幕';
    ui.stop.hidden = !busy;
    ui['download-all'].disabled = done === 0;
  }

  function addFiles(files) {
    if (run) return;
    let added = 0;
    let ignored = 0;
    const rows = document.createDocumentFragment();
    for (const file of files) {
      if (!extensions.test(file.name)) {
        ignored++;
        continue;
      }
      const path = file.webkitRelativePath || file.name;
      const key = JSON.stringify([path, file.size, file.lastModified]);
      if (keys.has(key)) continue;
      keys.add(key);
      const job = { file, path, name: Subtitle.outputName(file.name), state: 'queued', detail: '等待處理' };
      jobs.push(job);
      rows.append(makeRow(job));
      added++;
    }
    ui.queue.append(rows);
    ui.message.textContent = added ? `已加入 ${added} 部影片。` :
      ignored ? '沒有找到支援的影片檔案。' : '選取的影片已在清單中。';
    refreshControls();
  }

  function request(worker, message, expected, signal, onProgress = () => {}, transfer = []) {
    return new Promise((resolve, reject) => {
      const error = event => {
        cleanup();
        reject(Object.assign(new Error(event.message || '背景處理程序已中斷。'), { fatal: true }));
      };
      const abort = () => {
        cleanup();
        reject(signal.reason);
      };
      const receive = ({ data }) => {
        if (data.type === 'progress') onProgress(data);
        if (data.type === expected || data.type === 'failure') {
          cleanup();
          if (data.type === 'failure') reject(new Error(data.message));
          else resolve(data);
        }
      };
      function cleanup() {
        signal.removeEventListener('abort', abort);
        worker.removeEventListener('message', receive);
        worker.removeEventListener('error', error);
        worker.removeEventListener('messageerror', error);
      }
      signal.throwIfAborted();
      signal.addEventListener('abort', abort, { once: true });
      worker.addEventListener('message', receive);
      worker.addEventListener('error', error);
      worker.addEventListener('messageerror', error);
      try { worker.postMessage(message, transfer); }
      catch (cause) { cleanup(); reject(cause); }
    });
  }

  async function start() {
    if (run) return;
    const pending = jobs.filter(job => ['queued', 'failed', 'stopped'].includes(job.state));
    if (!pending.length) return;
    run = new AbortController();
    const { signal } = run;
    const language = ui.language.value;
    let worker;
    let workerUrl;

    refreshControls();
    try {
      ui.message.textContent = '正在載入本機辨識模型…';
      const load = id => {
        signal.throwIfAborted();
        return OfflineAssets.load(id, signal);
      };
      const textDecoder = new TextDecoder();
      const ffmpegScript = textDecoder.decode(await load('ffmpeg-runtime'));
      const whisperScript = textDecoder.decode(await load('whisper-runtime'));
      const ffmpegWasm = await load('ffmpeg-wasm');
      const whisperWasm = await load('whisper-wasm');
      const model = await load('whisper-model');
      signal.throwIfAborted();
      const source = [ffmpegScript, '\n;\n', whisperScript, '\n;\n', `(${subtitleWorkerMain.toString()})();`];
      workerUrl = URL.createObjectURL(new Blob(source, { type: 'text/javascript' }));
      worker = new Worker(workerUrl);
      await request(worker, { type: 'init', ffmpegWasm, whisperWasm, model }, 'ready', signal, undefined,
        [ffmpegWasm.buffer, whisperWasm.buffer, model.buffer]);

      for (const [index, job] of pending.entries()) {
        signal.throwIfAborted();
        ui.message.textContent = `正在處理 ${index + 1}／${pending.length} 部影片…`;
        job.state = 'working';
        job.detail = '正在讀取音軌…';
        paintJob(job);
        try {
          const result = await request(worker, { type: 'transcribe', file: job.file, language }, 'result', signal, update => {
            job.percent = update.stage === 'recognize' ? Math.max(0, Math.min(100, Math.round(update.percent))) : null;
            job.detail = job.percent == null ? '正在讀取音軌…' : `正在辨識語音 · ${job.percent}%`;
            paintJob(job);
          });
          job.srt = Subtitle.toSrt(result.segments, result.duration);
          job.state = job.srt ? 'done' : 'empty';
          const detected = result.language ? displayLanguage.of(result.language) : '';
          job.detail = job.srt ? `已完成${detected ? ` · ${detected}` : ''} · ${job.name}` : '未辨識到可輸出的語音。';
        } catch (error) {
          job.state = signal.aborted ? 'stopped' : 'failed';
          job.detail = signal.aborted ? '已停止，可重新處理。' : error.message;
          if (error.fatal) {
            paintJob(job);
            throw error;
          }
        }
        job.percent = null;
        paintJob(job);
        refreshControls();
      }
      signal.throwIfAborted();
      ui.message.textContent = '本次處理結束。';
    } catch (error) {
      ui.message.textContent = signal.aborted ? '已停止處理。' :
        `${error.fatal ? '背景處理已中斷。' : '無法啟動離線辨識。'}${error.message}`;
    } finally {
      worker?.terminate();
      if (workerUrl) URL.revokeObjectURL(workerUrl);
      run = null;
      refreshControls();
    }
  }

  for (const type of ['file', 'folder']) {
    const input = ui[`${type}-input`];
    ui[`choose-${type}`].onclick = () => input.click();
    input.onchange = () => {
      if (input.files.length) addFiles(input.files);
      input.value = '';
    };
  }
  ui.dropzone.ondragover = event => {
    event.preventDefault();
    if (!run) ui.dropzone.classList.add('is-over');
  };
  ui.dropzone.ondragleave = () => ui.dropzone.classList.remove('is-over');
  ui.dropzone.ondrop = event => {
    event.preventDefault();
    ui.dropzone.classList.remove('is-over');
    addFiles(event.dataTransfer.files);
  };
  ui.start.onclick = start;
  ui.stop.onclick = () => run?.abort();
  ui.clear.onclick = () => {
    jobs.length = 0;
    keys.clear();
    ui.queue.replaceChildren();
    ui.message.textContent = '';
    refreshControls();
  };
  ui['download-all'].onclick = () => {
    try {
      download(Subtitle.makeZip(jobs.filter(job => job.state === 'done')), '影片字幕.zip');
    } catch (error) {
      ui.message.textContent = error.message;
    }
  };
})();
