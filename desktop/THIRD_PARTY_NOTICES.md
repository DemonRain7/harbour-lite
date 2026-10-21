# Harbour Desktop third-party notices

Harbour can use Live2D Cubism SDK components installed into the owner's platform-local data directory.

- **Folia** — © chthollyphile and contributors, AGPL-3.0; upstream
  <https://github.com/chthollyphile/folia-major>, pinned revision recorded in
  `vendor/folia/UPSTREAM.json`. Source, original notices and `LICENSE` are retained in
  `vendor/folia/`; packaged resources include the Folia license and provenance.
  Harbour host patches are listed in `UPSTREAM.json`. Folia's separate updater is disabled.
  The small Windows x64 wallpaper helper comes from Folia's official v0.7.4 release;
  its source/binary hashes and origin are in `desktop/folia/vendor/windows-wallpaper/provenance.json`
  and the packaged `folia/build/folia-wallpaper-helper.provenance.json`. Full helper source is retained.
- **Folia bundled FFmpeg runtime** — the pinned upstream audio-runtime artifact includes its
  own license, build provenance and redistribution metadata under `folia/ffmpeg-audio`.
  Folia's dependency packages retain their individual licenses.

- **Live2D Cubism Core** — © Live2D Inc.; proprietary and not stored in the Harbour repository or
  bundled installer. Automatic installation is disabled in this public source copy; explicitly
  setting `HARBOUR_LIVE2D_AUTO_INSTALL=1` enables the official download. Running that installer constitutes
  the owner's choice to install the package. Use remains subject to the Live2D Proprietary
  Software License / SDK Release License. See <https://www.live2d.com/en/sdk/license/>.
- **pixi-live2d-display** — © guansss and contributors, MIT License.
  <https://github.com/guansss/pixi-live2d-display>
- **PixiJS** — © PixiJS contributors, MIT License. <https://github.com/pixijs/pixijs>

The source-code licenses above do not grant rights to unrelated character art, voices, music,
stickers, or intellectual property. User-imported assets remain subject to their own terms.
