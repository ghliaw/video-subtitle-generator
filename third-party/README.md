# FFmpeg WebAssembly source

`ffmpeg-core-0.12.10-source.tar` contains the source snapshots and the upstream build scripts for the single-threaded `@ffmpeg/core` 0.12.10 used by this project. Unpack the outer archive to read `sources.json` for immutable revisions and SHA-256 checksums. The source of each component includes its own notices and license terms.

The two distributed files, `vendor/ffmpeg-runtime.js` and `vendor/ffmpeg-wasm.js`, wrap the original UMD files as base64 data for loading from a local HTML file. The application does not patch the FFmpeg executable or its glue. The original npm archive is integrity-pinned in [`prepare-assets.mjs`](../prepare-assets.mjs). The FFmpeg core is licensed under GPL-2.0-or-later. The upstream ffmpeg.wasm packaging code is MIT.

## Build recipe

1. Extract `ffmpeg-wasm.tar.gz`. Its `Dockerfile`, `Makefile`, `build/`, `src/bind/` and `src/fftools/` contain the upstream recipe at tag `v12.15`, which shipped core 0.12.10.
2. Run `make prd` in that checkout with Docker and Buildx to use the upstream recipe. The production single-threaded build uses Emscripten 3.1.40, FFmpeg 5.1.4, `FFMPEG_ST=yes`, and `-O3 -msimd128`.
3. To build from the snapshots, unpack the library archives with `tar -xf ARCHIVE --strip-components=1 -C DIRECTORY` into separate directories in the Docker build context. Replace each `ADD https://… /src` in the upstream Dockerfile with `COPY DIRECTORY /src` for its corresponding library. For zimg, replace the `git clone` step with the equivalent `COPY`, including the GoogleTest archive at `test/extra/googletest` if using its tests. The SDL2 port is supplied by the upstream Emscripten port recipe, and this archive also includes the matching SDL2 source. The ordinary UMD build output is `packages/core/dist/umd/`.

Fixed tags and the release-date revisions of branch references are recorded in `sources.json`. The project distributes the upstream npm binaries. The source archive records the upstream recipe and input snapshots for rebuilding them.
