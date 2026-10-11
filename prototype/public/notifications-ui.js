(function (root) {
  const DEVICE_KEY = "fm-quarterdeck-push-device-v1";
  const PREFERENCE_KEY = "fm-quarterdeck-push-alerts-v1";
  function capabilities(browser) {
    const ios = /iPad|iPhone|iPod/.test(browser.navigator.userAgent) || browser.navigator.platform === "MacIntel" && browser.navigator.maxTouchPoints > 1;
    if (!browser.isSecureContext || !browser.navigator.serviceWorker || !browser.PushManager || !browser.Notification) return "unsupported";
    if (ios && !browser.navigator.standalone && !browser.matchMedia("(display-mode: standalone)").matches) return "install-ios";
    return "supported";
  }
  function publicKeyBytes(text) {
    const raw = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(raw, (char) => char.charCodeAt(0));
  }
  function mount(browser, element) {
    if (!element) return;
    const status = element.querySelector("[data-notification-status]");
    const enable = element.querySelector("[data-notification-enable]");
    const disable = element.querySelector("[data-notification-disable]");
    const check = element.querySelector("[data-notification-check]");
    const preference = element.querySelector("[data-notification-preference]");
    if (browser.FM_STANDALONE_UAT || browser.FM_HOST_ID === "uat" || (browser.FM_PREVIEW_ID && browser.FM_PREVIEW_ID !== "main") || browser.location.pathname?.startsWith("/preview/")) {
      status.textContent = "Notifications are available only on the stable private Main host.";
      return;
    }
    let id, alertsOn, config = null, busy = false;
    try {
      const saved = browser.localStorage.getItem(PREFERENCE_KEY);
      if (saved != null && saved !== "true" && saved !== "false") throw new Error("Invalid alert preference");
      alertsOn = saved !== "false";
      preference.checked = alertsOn; preference.disabled = false;
      id = browser.localStorage.getItem(DEVICE_KEY);
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id || "")) {
        id = browser.crypto.randomUUID(); browser.localStorage.setItem(DEVICE_KEY, id);
      }
    }
    catch { preference.disabled = true; status.textContent = "Notifications need browser storage. Allow storage or repair the saved preference, then reload."; return; }
    function savePreference(value) {
      try {
        browser.localStorage.setItem(PREFERENCE_KEY, JSON.stringify(value));
        alertsOn = value; preference.checked = value;
        return true;
      } catch {
        preference.checked = alertsOn;
        status.textContent = "Could not save the alert preference. Allow browser storage, then retry.";
        return false;
      }
    }
    function describe(message) {
      const permission = browser.Notification?.permission;
      const label = { default: "not granted", denied: "denied", granted: "granted" }[permission] || "unknown";
      return `Captain's Call alert preference is ${alertsOn ? "on" : "off"}. Browser permission: ${label}. ${message}`;
    }
    const api = async (operation, extra = {}) => {
      const response = await browser.fetch(`/api/notifications/${operation}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, ...extra }), cache: "no-store" });
      if (!response.ok) throw new Error("Notification operation unavailable");
      return response.json();
    };
    async function registration() {
      const value = await browser.navigator.serviceWorker.getRegistration("/");
      return value && [value.active, value.waiting, value.installing].some((worker) => worker?.scriptURL === `${browser.location.origin}/notifications-worker.js`) ? value : null;
    }
    async function refresh() {
      if (busy) return;
      busy = true; preference.disabled = enable.disabled = disable.disabled = check.disabled = true;
      try {
        config = await api("status");
        const capability = capabilities(browser), permission = browser.Notification?.permission;
        let subscription = null;
        if (capability === "supported") subscription = await (await registration())?.pushManager.getSubscription();
        const labels = { "operator-disabled": "Notifications are off in the server configuration.", "needs-repair": "Notification state needs operator repair.", "not-enabled": "Notifications are not enabled on this installation.", "waiting-for-baseline": "Enrolled. Waiting for a fresh baseline; existing calls will not alert.", "eligibility-unavailable": "Enrolled. Call or answer evidence is unavailable; sends are postponed.", "revision-unavailable": "Sends stopped. The server revision needs attention.", "waiting": "Enrolled. Checking current call coverage." };
        let message = labels[config.state] || (config.state === "enabled" ? "Enabled for newly actionable filed calls. Arrival is best effort." : "Notification status unavailable.");
        if (capability === "unsupported") message += " This browser does not support notifications here. Use the private HTTPS app in a supported browser.";
        else if (capability === "install-ios") message += " On iOS, add Quarterdeck to the Home Screen and enable notifications from the installed app.";
        else if (!["default", "denied", "granted"].includes(permission)) message += " Browser permission is unknown. Check browser settings; enrollment is unavailable.";
        else if (permission === "denied") message += " Permission is denied. Change browser or OS notification settings, then check status.";
        else if (config.subscribed && (permission !== "granted" || !subscription)) message += " Server enrollment needs repair. Check permission settings, then enable again or disable.";
        if (config.subscribed && config.failed) message += " A provider attempt failed; check operator configuration.";
        if (config.subscribed && config.retrying) message += " Some sends are waiting to retry.";
        if (config.accepted) message += ` Provider accepted: ${config.accepted}. Display and reading are unknown.`;
        if (!alertsOn && config.subscribed) message += " Server enrollment is still active; disable notifications to complete opt-out.";
        status.textContent = describe(message);
        enable.textContent = config.subscribed ? "Repair enrollment" : "Enable notifications";
        enable.disabled = capability !== "supported" || !config.configured || config.state === "needs-repair" || !["default", "granted"].includes(permission) || config.origin !== browser.location.origin;
        disable.disabled = !alertsOn && !config.subscribed && !subscription;
      } catch { config = null; status.textContent = describe("Status unavailable. Connect to the private network, then check status.");
        disable.disabled = false; }
      finally { busy = false; preference.disabled = check.disabled = false; }
    }
    enable.addEventListener("click", async () => {
      if (busy || enable.disabled || !config?.configured) return;
      if (!savePreference(true)) return;
      busy = true; preference.disabled = enable.disabled = disable.disabled = check.disabled = true;
      let enrolled = false;
      try {
        // Request directly within this deliberate tap. Refresh never prompts.
        const permission = browser.Notification.permission === "granted" ? "granted" : await browser.Notification.requestPermission();
        if (permission !== "granted") { status.textContent = describe(permission === "denied" ? "Permission denied. Use browser or OS settings to change it." : "Permission was not granted. No alerts are enabled."); return; }
        await browser.navigator.serviceWorker.register("/notifications-worker.js", { scope: "/", updateViaCache: "none" });
        const worker = await browser.navigator.serviceWorker.ready;
        let subscription = await worker.pushManager.getSubscription();
        if (subscription && subscription.options?.applicationServerKey && Array.from(new Uint8Array(subscription.options.applicationServerKey)).join() !== Array.from(publicKeyBytes(config.publicKey)).join()) throw new Error("Key changed; disable before reenrolling");
        subscription ||= await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKeyBytes(config.publicKey) });
        await api("enroll", { subscription: subscription.toJSON() });
        enrolled = true;
      } catch { status.textContent = describe("Could not enroll. Permission alone does not enable alerts. Check status and retry on the private network."); }
      finally { busy = false; preference.disabled = check.disabled = false; enable.disabled = !["default", "granted"].includes(browser.Notification.permission); disable.disabled = false; if (enrolled) await refresh(); }
    });
    async function turnOff() {
      if (busy) return;
      if (!savePreference(false)) return;
      busy = true; preference.disabled = enable.disabled = disable.disabled = check.disabled = true;
      let disabled = false;
      try {
        config = await api("disable"); // Cancel durable server work before removing browser delivery.
        const worker = await registration();
        const subscription = await worker?.pushManager.getSubscription();
        if (subscription) await subscription.unsubscribe();
        await worker?.unregister();
        disabled = true;
        enable.textContent = "Enable notifications";
        status.textContent = describe("Disabled. OS permission may remain granted in settings.");
      } catch { status.textContent = describe("Could not fully disable. Connect to the private network and retry, or ask the operator to repair configuration; check browser settings too."); }
      finally { busy = false; preference.disabled = check.disabled = false; enable.disabled = !config?.configured || !["default", "granted"].includes(browser.Notification?.permission); disable.disabled = disabled; }
    }
    disable.addEventListener("click", turnOff);
    preference.addEventListener("change", async () => {
      if (busy) { preference.checked = alertsOn; return; }
      if (!preference.checked) await turnOff();
      else if (savePreference(true)) await refresh(); // A preference is not enrollment or browser consent.
    });
    check.addEventListener("click", () => { void refresh(); });
    browser.addEventListener("focus", () => { void refresh(); });
    void refresh();
    return { refresh };
  }
  root.quarterdeckNotifications = { mount, capabilities };
  if (root.document) mount(root, root.document.querySelector("#notification-preferences"));
})(globalThis);
