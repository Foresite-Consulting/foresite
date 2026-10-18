/**
 * Headers for every `/theme-assets/<file>` response. Middleware does not run
 * on that route (no nonce needed), so it sets its own CSP: an SVG opened
 * directly is a document and could otherwise run script or load anything.
 * `sandbox` and `default-src 'none'` stop that; inline styles are allowed
 * because SVG logos commonly use them.
 */
export const THEME_ASSET_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
