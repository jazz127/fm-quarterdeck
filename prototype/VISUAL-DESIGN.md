# Visual design contract

Quarterdeck uses a quiet reading workspace: warm white canvas, light content surfaces and dark forest ink, with a dark app-shell panel. Selection, identity, status and focus have text/shape semantics as well as color. Fonts are local system fonts, not remote dependencies.

- Conversation text, supporting controls and metadata have distinct readable scales. Thinking and crew records use labeled disclosures, not invented content.
- Spacing and corner tokens live in `public/styles.css` and `public/shell-panel.css`. Essential touch targets remain reachable without horizontal page overflow.
- Desktop shell disclosure/resizing uses one edge stripe. Lane and kind filters have independent panels; context/history use bounded scroll areas. Phone/tablet disclosures preserve native focus, Escape and close behavior.
- Message prose has a readable width while structured content may use the pane. Feed paging is bounded independently of loaded source history.
- Overview, Expenses, Quota, Preferences and closed history share heading, card, status and empty/unavailable conventions.

## Acceptance, not historical results

Run synthetic renderer and CSS-model regressions, then a separately authorized exact-revision browser matrix. Static tests are not browser-paint evidence. Check desktop, coarse-pointer tablet and narrow phone geometry; long labels/amounts; independent scrolling; keyboard focus/activation; forced colors; reduced motion; and resize in both directions. Body text should meet WCAG AA contrast (4.5:1), controls 3:1.

Use `LAYOUT-CORRECTION.md` for detailed layout/intake distinctions and `WORK-TAXONOMY.md` for work semantics. Capture only synthetic fixture evidence for public documentation. No service restart, integration, publication or historical acceptance is implied by this contract.
