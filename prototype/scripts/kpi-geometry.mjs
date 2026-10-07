// Shared deterministic acceptance diagnostics. Hidden Overview cards on Work Split
// are not phone layout evidence; zero rectangles there are expected.
export function captureKpiGeometry() {
  const grid = document.querySelector('#summary');
  const overview = document.querySelector('#overview-view');
  const style = grid && getComputedStyle(grid);
  const rect = (node) => node.getBoundingClientRect().toJSON();
  return { route: location.hash, overviewActive: Boolean(overview?.classList.contains('active')),
    viewport: { width: innerWidth, height: innerHeight, clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth, visual: window.visualViewport ? { width: window.visualViewport.width, height: window.visualViewport.height, left: window.visualViewport.offsetLeft, top: window.visualViewport.offsetTop } : null },
    grid: grid ? { ...rect(grid), display: style.display, columns: style.gridTemplateColumns, gap: style.gap } : null,
    cards: [...document.querySelectorAll('#summary .metric-card')].map(node => ({ ...rect(node), clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, text: node.innerText })) };
}
export function inspectKpiGeometry(diagnostic) {
  if (!diagnostic.overviewActive) return { applicable: false, failures: [] };
  const failures = [];
  const { grid, cards, viewport } = diagnostic;
  if (!grid || grid.width <= 0 || grid.height <= 0) failures.push('Overview KPI grid is hidden or has zero area');
  if (cards.length !== 3) failures.push(`Expected three KPI cards, received ${cards.length}`);
  for (const [index, card] of cards.entries()) {
    if (card.width <= 0 || card.height <= 0) failures.push(`Card ${index} has zero area`);
    if (Math.abs(card.top - cards[0].top) > 1) failures.push(`Card ${index} is not in the same row`);
    if (card.left < Math.max(0, grid?.left || 0) - 1 || card.right > Math.min(viewport.clientWidth, grid?.right ?? viewport.clientWidth) + 1) failures.push(`Card ${index} is clipped horizontally`);
    if (index && card.left < cards[index - 1].right - 1) failures.push(`Card ${index} overlaps its predecessor`);
    if (card.scrollWidth > card.clientWidth + 1) failures.push(`Card ${index} content overflows its box`);
  }
  return { applicable: true, failures };
}
