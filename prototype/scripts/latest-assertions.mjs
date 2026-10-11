import assert from "node:assert/strict";

export function createLatestAssertion({ distance, evaluate, width, height, includeNativeBottom = false, log = console.log }) {
  return async ({ quarantineNativeBottom = false } = {}) => {
    if (!quarantineNativeBottom || includeNativeBottom) {
      assert.ok(await distance() <= 1, "Latest reaches the native scroll bottom");
    } else {
      log(`${width}x${height}: CI-Q3 ${quarantineNativeBottom} native-bottom assertion EXCLUDED; https://github.com/sthi-1005/fm-quarterdeck/issues/83 (not native acceptance)`);
    }
    assert.equal(await evaluate("document.querySelector('#jump-to-latest-floating').hidden"), true);
    assert.equal(await evaluate("document.querySelector('#transcript-newer').disabled"), true, "latest loaded page selected");
    assert.ok(await evaluate(`(() => {const f=document.querySelector('#messages'), r=f.getBoundingClientRect();
      const last=f.querySelector('article.message:last-child').getBoundingClientRect();
      const dock=document.querySelector('#mobile-dock')?.getBoundingClientRect();
      return last.bottom<=r.bottom && (!dock?.height || last.bottom<=dock.top);})()`), "last original row clears feed and dock");
  };
}
