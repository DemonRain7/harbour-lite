# Harbour wordmark fonts

Local, Latin-only WOFF2 subsets for the **Harbour** header wordmark. They do not
replace the UI/body fonts or require a font service, account, or network request.
Both upstream fonts use the SIL Open Font License 1.1; their unmodified license
and copyright notices are included alongside the subsets.

- Handwritten theme: [Caveat](https://github.com/googlefonts/caveat), upstream
  `google/fonts` commit `5571d84c0d8c70ec1af4f64072d8c5cf1e4e9643`,
  `ofl/caveat/Caveat[wght].ttf`.
- Editorial theme: [Cormorant Garamond](https://github.com/CatharsisFonts/Cormorant),
  upstream `google/fonts` commit `3dd78844021e948ceb633d1dcee3f7885561b5d9`,
  `ofl/cormorantgaramond/CormorantGaramond-Italic[wght].ttf`.

Generated with fontTools 4.60.1 and Brotli, retaining variable weight, kerning,
and contextual shaping for the wordmark. Reproduction (source TTFs need not
be shipped):

```sh
python -m fontTools.subset 'Caveat[wght].ttf' --text=Harbour --flavor=woff2 --layout-features='*' --output-file=caveat-harbour.woff2
python -m fontTools.subset 'CormorantGaramond-Italic[wght].ttf' --text=Harbour --flavor=woff2 --layout-features='*' --output-file=cormorant-garamond-italic-harbour.woff2
```

Use these only for the wordmark: they are intentionally not general-purpose
fonts. The normal system-font fallback keeps the name legible if loading fails.
