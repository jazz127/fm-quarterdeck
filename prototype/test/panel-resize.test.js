import test from "node:test";
import assert from "node:assert/strict";
import { attachPanelResize } from "../public/panel-resize.js";

function element() {
  const listeners = new Map();
  const values = new Map();
  return {
    style: { setProperty: (key, value) => values.set(key, value), removeProperty: (key) => values.delete(key), getPropertyValue: (key) => values.get(key) || "" },
    addEventListener: (name, fn) => listeners.set(name, fn),
    fire: (name, event = {}) => listeners.get(name)(event),
    attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, value); }, removeAttribute(name) { this.attributes.delete(name); }, setPointerCapture() {},
  };
}

test("quota and Review persist and reset only their own bounded desktop dimensions", () => {
  const previousWindow = globalThis.window;
  const previousStyle = globalThis.getComputedStyle;
  globalThis.window = { addEventListener() {} };
  globalThis.getComputedStyle = (el) => el.style;
  try {
    const values = new Map();
    const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
    const make = (key, property, direction, initial, min, max) => {
      const panel = element(), handle = element();
      attachPanelResize({ panel, handle, property, key, direction, initial, min: () => min, maximum: () => max, storage, desktop: { matches: true } });
      return { panel, handle };
    };
    const quota = make("quota", "--quota-height", "vertical", 220, 120, 400);
    const review = make("review", "--review-width", "horizontal", 600, 320, 900);
    const key = (handle, name) => handle.fire("keydown", { key: name, preventDefault() {} });
    key(quota.handle, "ArrowUp");
    key(review.handle, "ArrowLeft");
    assert.equal(values.get("quota"), "240");
    assert.equal(values.get("review"), "620");
    quota.handle.fire("keydown", { key: "Home", preventDefault() {} });
    assert.equal(values.has("quota"), false);
    assert.equal(quota.panel.style.getPropertyValue("--quota-height"), "");
    assert.equal(values.get("review"), "620");
    const reloadedReview = make("review", "--review-width", "horizontal", 600, 320, 900);
    assert.equal(reloadedReview.panel.style.getPropertyValue("--review-width"), "620px");
    key(reloadedReview.handle, "ArrowLeft");
    reloadedReview.handle.fire("dblclick");
    assert.equal(values.has("review"), false);
    assert.equal(quota.panel.style.getPropertyValue("--quota-height"), "");
    for (let i = 0; i < 30; i++) key(quota.handle, "ArrowUp");
    assert.equal(values.get("quota"), "400");
    quota.handle.fire("pointerdown", { button: 0, pointerId: 1, clientY: 200, preventDefault() {} });
    quota.handle.fire("pointermove", { pointerId: 1, clientY: 800 });
    quota.handle.fire("pointerup", { pointerId: 1 });
    assert.equal(values.get("quota"), "120");
    assert.equal(quota.handle.attributes.get("aria-valuenow"), "120");
    assert.equal(quota.handle.attributes.get("aria-valuemin"), "120");
    assert.equal(quota.handle.attributes.get("aria-valuemax"), "400");
    review.handle.fire("pointerdown", { button: 0, pointerId: 2, clientX: 500, preventDefault() {} });
    review.handle.fire("pointermove", { pointerId: 2, clientX: 300 });
    review.handle.fire("pointerup", { pointerId: 2 });
    assert.equal(values.get("review"), "820");
    assert.equal(quota.panel.style.getPropertyValue("--quota-height"), "120px");
    const phone = make("phone", "--review-width", "horizontal", 600, 320, 900);
    // Phone behavior is gated by media query in the actual registration; independent state remains absent.
    assert.equal(values.has("phone"), false);
  } finally { globalThis.window = previousWindow; globalThis.getComputedStyle = previousStyle; }
});
