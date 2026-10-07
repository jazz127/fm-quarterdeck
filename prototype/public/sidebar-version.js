// Shared presentation of served version; the host supplies source and publication evidence.
(() => {
  const button = document.querySelector("#sidebar-version");
  if (!button) return;
  const cloudIcon = (published) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 18h12a4 4 0 0 0 .2-8A6 6 0 0 0 6.5 9 4.5 4.5 0 0 0 6 18Z"/>${published ? "" : '<path d="M3 21 21 3"/>'}</svg>`;
  const render = (identity) => {
    const { name, source, revision, publication, action = "" } = identity || {};
    if (!name || !["local", "origin"].includes(source) || !/^[a-f0-9]{40}$/.test(revision || "") ||
      !["published", "unpublished", "publication unverified"].includes(publication)) {
      button.hidden = true;
      return;
    }
    button.hidden = false;
    button.querySelector(".sidebar-version-source").textContent = name;
    button.querySelector(".sidebar-version-publication").innerHTML = publication === "publication unverified"
      ? '<span class="sr-only">Publication unverified</span>' : cloudIcon(publication === "published");
    button.querySelector(".sidebar-version-hash").textContent = revision.slice(0, 6);
    button.setAttribute("aria-label", `${name}, ${source}, ${publication}, full revision ${revision}${action ? `. ${action}` : ""}`);
    button.title = button.getAttribute("aria-label");
  };
  window.fmSidebarVersion = { render };
  if (window.FM_STANDALONE_UAT) {
    render(window.FM_STANDALONE_UAT);
    const detail = document.querySelector("#sidebar-version-detail");
    detail.textContent = button.getAttribute("aria-label");
    button.setAttribute("aria-controls", "sidebar-version-detail");
    button.setAttribute("aria-expanded", "false");
    button.addEventListener("click", () => {
      detail.hidden = !detail.hidden;
      button.setAttribute("aria-expanded", String(!detail.hidden));
    });
  }
})();
