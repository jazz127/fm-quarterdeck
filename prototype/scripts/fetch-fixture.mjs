// Synthetic response interception with explicit document and shutdown lifetimes.
export function fetchFixture(browser, respond) {
  const requests = new Map(), cancelled = new Set(), loaders = new Map();
  const pending = new Set(), errors = [];
  let stopping = false;
  const stale = (request) => Boolean(request.networkId && (cancelled.has(request.networkId)
    || (request.loaderId && loaders.has(request.frameId) && loaders.get(request.frameId) !== request.loaderId)));
  const act = (request, method, params = {}) => {
    if (stopping || stale(request)) return Promise.resolve();
    const action = browser.command(method, { ...params, requestId: request.requestId })
      .catch(error => { errors.push({ error, method, raced: stale(request) }); })
      .finally(() => pending.delete(action));
    pending.add(action);
    return action;
  };
  browser.onEvent(event => {
    if (event.method === 'Network.requestWillBeSent') {
      const { requestId, request, loaderId, frameId } = event.params;
      if (new URL(request.url).pathname === '/api/review') requests.set(requestId, { loaderId, frameId });
    } else if (event.method === 'Network.loadingFailed' && event.params.canceled) {
      if (requests.has(event.params.requestId)) cancelled.add(event.params.requestId);
    } else if (event.method === 'Page.frameNavigated') {
      const { id, loaderId } = event.params.frame;
      loaders.set(id, loaderId);
    } else if (event.method === 'Fetch.requestPaused' && !stopping) {
      const request = { ...event.params, ...requests.get(event.params.networkId) };
      respond(request, (method, params) => act(request, method, params), stale(request));
    }
  });
  return {
    act, stale,
    async stop() {
      // Fetch.disable releases requests that arrive during the drain. Issue no
      // new commands for them, and never invalidate a command already in flight.
      stopping = true;
      await Promise.all(pending);
      await browser.command('Fetch.disable');
      for (const { error, method, raced } of errors) {
        if (['Fetch.continueRequest', 'Fetch.failRequest', 'Fetch.fulfillRequest'].includes(method)
          && error.cdpError?.code === -32602 && error.cdpError?.message === 'Invalid InterceptionId.' && raced) continue;
        throw error;
      }
    },
  };
}
