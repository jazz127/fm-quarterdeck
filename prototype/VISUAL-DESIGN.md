# Visual design contract

Quarterdeck uses a quiet reading workspace: warm white canvas, light content surfaces and dark forest ink, with a dark app-shell panel. Selection, identity, status and focus have text/shape semantics as well as color. Fonts are local system fonts, not remote dependencies.

- Conversation text, supporting controls and metadata have distinct readable scales. Thinking and crew records use labeled disclosures, not invented content.
- Spacing and corner tokens live in `public/styles.css` and `public/shell-panel.css`. Essential touch targets remain reachable without horizontal page overflow.
- Desktop shell disclosure/resizing uses one edge stripe. Lane and kind filters have independent panels; context/history use bounded scroll areas. Phone/tablet disclosures preserve native focus, Escape and close behavior.
- Message prose has a readable width while structured content may use the pane. Feed paging is bounded independently of loaded source history.
- Expenses, Quota, Preferences and closed history share heading, card, status and empty/unavailable conventions.
- Overview keeps those poster cards and uses the bearings board for the page around them: the existing canvas, accent eyebrows, and one control rhythm.
- Captain's Call cards are poster cards on the light canvas: a 2px forest-ink border, a 3px hard shadow, and an enamel type chip that keeps its written words.
- Decision chips use the accent fill, merge chips an amber mix with dark ink, and chat-ask chips a dashed surface.
- The title is the full ask or reason.
- Context keys are small uppercase monospace.
- Option rows use a warm surface and an accent ring when selected, and Recommended is an uppercase amber chip.
- Queue is accent-filled with an ink border; a merge Queue uses the amber mix.
- Held cards keep their update notice at full strength, with no dimmed or outdated treatment.
- Long titles, options, links and ids wrap so the full text stays readable on desktop and on a phone.
- Thread history stays collapsed. A card with two or more entries shows an expand control with the entry count; one entry does not.
- Each card has one text box, with Queue, Send and Edit beside it, and the hint "Pick an option to answer, or just type - Firstmate replies in the thread."
- Opening a thread shows the latest exchange above that box, the count of earlier messages, and a control that expands the same history.
- Each card carries a small coloured dot beside the type chip, one colour per state: Active green, Queued amber, Sent blue, Procrastinated muted.
- Both Sent labels, waiting for Firstmate to read and Firstmate is on it, use the Sent blue dot.
- A reply returns the card to the Active green dot.
- The dot has an accessible name. Sent uses a dashed border and Procrastinated a dotted border. The status words and counts live only on the status control.
- One status control above the cards offers Active, Queued, Sent, Procrastinated, and All, each with a count.
- Active is pressed on the first load.
- A pressed status uses the accent fill plus an ink shadow, and every status button is at least 44px high.
- Procrastinate is a header pill at the card's top-right, beside the repository name and beside Review dismissal on a chat ask.
- It matches the type badge's height, radius and weight, and opens 3h, 6h, 1d and 3d.
- The same pill stays available on Sent cards and in the Procrastinated status.
- The Overview field uses the canvas token, and poster cards stay on the surface token.
- Stat cards, empty panels, option rows, and thread panels use the surface, soft-surface, line, and line-strong tokens.
- The page title and the activity clocks share one row when they fit. The three KPI cards use the soft surface and a monospace figure, in one row from the phone width upward.
- Section headings are uppercase accent eyebrows. The live-confirmation note sits on its own quiet line under Captain's Call.
- Below the page header and the KPI summary, the Overview body is two equal columns with a 22px gap.
- Captain's Call stays in the first column. Sort sits on the heading row there, and on its own row on a phone.
- The status control is two even rows, three buttons then two, with a quiet border on the unselected buttons.
- Send queued is a full-width accent button under that status control.
- An empty Captain's Call or Just landed list is a dashed soft-surface panel with the same minimum height.
- Just landed fills the second column (`#overview-secondary`) with the same poster cards: a Landed chip, the repository, the clock, the full landing title, and a full pull-request link or the label local main.
- Its heading and Acknowledged control share one row. Acknowledged uses the quiet border until it is pressed.
- Each landed card has an Acknowledge control and one follow-up box. It has no Procrastinate control.
- The Just landed heading shows the new, unacknowledged count in the Captain's Call count badge. The badge hides when that count is 0.
- Acknowledge and Acknowledged (N) are at least 44px high.
- Underway and Charted Next follow Just landed in the second column, using the same poster cards and source state/reason text. Repair warnings are excluded from queued counts. On a phone the four Overview sections are tabs, Captain's Call (N), Just landed (N), Underway (N) and Charted Next (N). Just landed N is the same new count, and the chosen tab is remembered for that viewer.
- Those tabs are one segmented control: a single ink border and hard shadow, with the selected tab in the accent fill.
- Chat asks keep a double left border at the same width as other cards, so the mark does not indent the card. Also asked in chat stacks on its own line and does not widen the context column.
- A decision title is the filed hold's full reason when one is recorded. Also asked in chat is a smaller secondary line, and a `[task:...]` marker is omitted. Reply phrases from that ask are option choices under the reason.
- Captain's Call answer forms separate source context from input with a quiet rule; option cards use native radios, a textual Recommended chip and visible keyboard focus. All call buttons and option targets are at least 44px high. Confirmation and receipt panels retain readable text (disabled fields use muted ink, not whole-form opacity), and phone actions wrap without overflow.
- A lettered choice uses the same radio row.
  The letter is the label, and the line's description sits under it.
- A sent answer's option rows, and any select, reuse the card's grey diagonal hatch. The chosen option keeps an accent bar. Your answer is a solid block under the sent label so the submitted label, hint, note and time stay readable on the hatch in light and dark.
- The content canvas is light, including under an OS dark preference; the app shell remains dark. Forced colors use system outlines and disabled text, not color-only selection.

## Acceptance, not historical results

Run synthetic renderer and CSS-model regressions, then a separately authorized exact-revision browser matrix. Static tests are not browser-paint evidence. Check desktop, coarse-pointer tablet and narrow phone geometry; long labels/amounts; independent scrolling; keyboard focus/activation; forced colors; reduced motion; and resize in both directions. Body text should meet WCAG AA contrast (4.5:1), controls 3:1.

Use `LAYOUT-CORRECTION.md` for detailed layout/intake distinctions and `WORK-TAXONOMY.md` for work semantics. Capture only synthetic fixture evidence for public documentation. No service restart, integration, publication or historical acceptance is implied by this contract.
