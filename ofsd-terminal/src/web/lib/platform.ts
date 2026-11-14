// Which build this is. "artifact" = the version that runs inside the Claude app
// (Claude on the viewer's plan, filings via the Robinhood connector, storage in
// the app). Anything else = the local server version.
export const IS_ARTIFACT = import.meta.env.VITE_TARGET === 'artifact';

/** How source locations are labelled: pages for EDGAR HTML, sections for connector text. */
export const PAGE_LABEL = IS_ARTIFACT ? '§' : 'p.';
