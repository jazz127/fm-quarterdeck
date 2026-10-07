// Only loaded by the local development server. EventSource reconnects across
// node --watch restarts; the version also catches changes missed while offline.
const versionAtLoad = document.currentScript.dataset.version;
const reloadEvents = new EventSource("/api/dev-reload");
reloadEvents.addEventListener("version", (event) => {
  if (event.data !== versionAtLoad) {
    reloadEvents.close();
    window.location.reload();
  }
});
