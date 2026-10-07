// Runs before app.js (module scripts execute in document order) so the first feed render sees the final column widths.
import { restoreShellWidth } from "./shell-panel-layout.js";

restoreShellWidth(document.querySelector(".workspace"), window.innerWidth, localStorage);
