# 離線影片字幕產生器

用 Windows 上的 Chrome 或 Edge 直接開啟 `index.html`。請保留同一資料夾內的 `app.js`、`worker.js`、`subtitle.js`、`style.css` 和 `vendor/`。語音模型與音訊解碼引擎已包含在 `vendor/`，開啟頁面即可離線使用。

1. 按「選擇影片」加入一部或多部影片，或按「選擇資料夾」掃描該資料夾及其子資料夾。也可以把影片拖到頁面上。瀏覽器選取資料夾時可能顯示「上傳」確認視窗，這是讓網頁讀取所選檔案的權限提示。
2. 按「開始產生字幕」。工具會依序讀取每部影片的第一條音軌。預設自動辨識語言並轉錄原文。如果影片都使用同一語言，也可手動指定。
3. 每部影片完成後，按「下載 SRT」。例如 `課堂錄影.mp4` 會輸出 `課堂錄影.srt`。批次下載請選「下載全部 ZIP」，壓縮檔會保留子資料夾結構。同資料夾有不同格式但同名的影片時，ZIP 會為重複的字幕檔名加上編號。
4. 在 YouTube Studio 選擇影片與字幕語言，再選「上傳檔案」與「含時間碼」，上傳 `.srt`。輸出是 UTF-8 純文字 SubRip 字幕。可參考 [YouTube 支援的字幕格式](https://support.google.com/youtube/answer/2734698?hl=zh-Hant)。

支援 MP4、M4V、MOV、MKV、WebM、AVI、MPEG、MPG、TS、MTS、M2TS、FLV、WMV、3GP 與 OGV。能否讀取仍取決於容器內的音訊編碼。沒有音軌、解碼失敗或未辨識到語音時，清單會顯示原因，其餘影片會繼續處理。

轉錄在背景執行，速度取決於影片長度與電腦效能。很長的影片會使用較多記憶體，可先切成較短的影片再處理。若要暫停批次，按「停止處理」，已完成的字幕仍可下載。請在重新整理或關閉頁面前下載結果。上傳前可先校對人名、專有名詞與時間碼。

## AI 使用聲明

- **開發過程**：本專案由使用者提出需求，使用 OpenAI Codex 協助設計、撰寫程式與文件、除錯，以及驗證離線轉錄與字幕下載流程。
- **工具執行時**：工具使用隨附的 OpenAI Whisper Base 多語模型辨識影片語音，產生原語言字幕。模型透過 WebAssembly 在本機瀏覽器執行，影片、音訊與字幕都留在本機，無需帳號或 API 金鑰。
- **輸出限制**：字幕由模型自動產生，可能出現漏字、誤聽或時間碼偏差。公開使用前請依原影片校對。

## 內附元件

- 音訊解碼使用 [ffmpeg.wasm 單執行緒核心 `@ffmpeg/core` 0.12.10](https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v12.15)。核心採 GPL-2.0-or-later，上游版本包含對應的原始碼、建置設定與依賴版本。ffmpeg.wasm 封裝程式採 MIT。
- 語音辨識使用 [whisper.node 的單執行緒 WebAssembly 1.2.0-rc.2](https://github.com/mybigday/whisper.node/tree/5274f7a7886557b665988fba505f7255db1a1bfb)，內含 [whisper.cpp](https://github.com/ggml-org/whisper.cpp)，採 MIT。隨附 [Whisper Base 多語量化模型](https://huggingface.co/ggerganov/whisper.cpp/blob/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base-q5_1.bin)，其上游 [OpenAI Whisper](https://github.com/openai/whisper) 採 MIT。
- `vendor/` 收錄上游授權檔。`prepare-assets.mjs` 可用來重建引擎與模型封裝，需要 Node.js 22、`tar` 和網路。平常開啟網頁不需要執行這支指令。封裝以本機指令碼載入模型資料，讓網頁直接從 `file://` 執行。
