# Web fonts

Self-hosted so that `next build` and the browser never contact Google Fonts. Loaded by `next/font/local` in `apps/web/lib/fonts.ts`; CSP stays `font-src 'self'`.

| File                                   | Family        | Weight | Bytes  |
| -------------------------------------- | ------------- | ------ | ------ |
| `ibm-plex-sans-latin-400-normal.woff2` | IBM Plex Sans | 400    | 22,588 |
| `ibm-plex-sans-latin-500-normal.woff2` | IBM Plex Sans | 500    | 24,184 |
| `ibm-plex-sans-latin-600-normal.woff2` | IBM Plex Sans | 600    | 24,252 |
| `ibm-plex-mono-latin-400-normal.woff2` | IBM Plex Mono | 400    | 14,708 |
| `ibm-plex-mono-latin-500-normal.woff2` | IBM Plex Mono | 500    | 14,888 |

Latin subset, normal style only (about 100 KB in total).

## Source

Copied unchanged from the `files/` folder of these npm packages (fetched with `npm pack`; they are not dependencies of this repo):

- `@fontsource/ibm-plex-sans@5.2.8` (tarball sha512 `MKAb8qV+CaiMQn2B0dIi1OV3565NYzp3WN5b4oT6LTkk+F0jR6j0ZN+5BKJiIhffDC3rtBULsYZE65+0018z9w==`)
- `@fontsource/ibm-plex-mono@5.2.7` (tarball sha512 `eztSXjDhPhcpxNIiGTgMebdLP9qS4rWkysuE1V7c+DjOR0qiezaiDaTwQE7bTnG5HxAY/8M43XKDvs3cYq6ZYQ==`)

## Licence

IBM Plex is © IBM Corp. and licensed under the SIL Open Font License 1.1; the full text is in `OFL.txt`, as shipped in those packages. The upstream IBM release reserves the font name "Plex".

## Adding or updating a font

1. `npm pack @fontsource/<family>@<exact version>` into a scratch folder and extract it.
2. Copy only the `files/<family>-latin-<weight>-normal.woff2` files needed here.
3. Register the family in `apps/web/lib/fonts.ts` and update this README (versions, sizes) and `OFL.txt` if the licence differs.
