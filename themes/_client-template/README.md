# Client theme: <client name>

Source of brand files: <who supplied them, date>

## How to fill this in

1. Copy this folder to `themes/<client-slug>/` and fill `tokens.json` from the client's own brand files. Any key left `null` falls back to `themes/foresite`.
2. Add the logo (SVG preferred), `logo-on-dark.svg` if the client has one, the app icons (192, 512 and maskable 512 PNG) and the favicon. Never redraw a logo from a description; if files are missing, leave the key `null` and flag it.
3. Run `npm run theme:check -- <client-slug>` and paste the results below. Every required pairing must pass before the theme ships. If one fails, change the mapping (for example a darker accent for `link`), never the client's colours.
4. Set `NEXT_PUBLIC_THEME=<client-slug>` in the client's environments.

## Colour mapping and contrast (WCAG 2.1 AA: 4.5:1 body text, 3:1 large text, UI and chart lines)

| Pairing                           | Light | Dark | Needs | Pass? |
| --------------------------------- | ----- | ---- | ----- | ----- |
| text-primary on bg                |       |      | 4.5   |       |
| text-primary on surface           |       |      | 4.5   |       |
| text-secondary on bg              |       |      | 4.5   |       |
| text-secondary on surface         |       |      | 4.5   |       |
| link on bg                        |       |      | 4.5   |       |
| link on surface                   |       |      | 4.5   |       |
| on-action on action               |       |      | 4.5   |       |
| positive indicator on surface     |       |      | 3     |       |
| negative indicator on surface     |       |      | 3     |       |
| forecast line on surface          |       |      | 3     |       |
| forecast line on bg               |       |      | 3     |       |
| focus indicator (link) on bg      |       |      | 3     |       |
| focus indicator (link) on surface |       |      | 3     |       |

Keyboard focus is drawn as an outline in the `link` colour, so `link` must reach 3:1 on `bg` and `surface` in both modes (it normally clears this already, since link text needs 4.5:1).

## Notes

- Only the client's logo and name appear in the app, plus a small "Built by Foresite" credit.
- Chart semantics stay fixed: actuals solid, comparisons muted, forecasts dotted with a shaded range.
