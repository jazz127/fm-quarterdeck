# Receipt retry regression verification

The oracle is the selected review decision and `prototype/BEARINGS.md`: the latest durable captain note owns lifecycle state; uncertain delivery retries preserve the exact attempted words and request ID. Fixtures use synthetic inbox records, client DOMs and session storage. They do not contact production accounts or services.

Before implementation changes, at commit `a59142b1662047c840e00bbdbd238b827234a627`, this command exited **1**, with **0 passing and 7 failing tests**:

```sh
npm exec --yes --cache ./.quarterdeck-review-runtime-01M4JCQ710P23W7SSY5CT5JSKJ --package=node@24 -- node --test prototype/test/receipt-retry-regressions.test.js
```

| Scenario | Observed before the fix | Required result |
| --- | --- | --- |
| Restarted answer retry, sent receipt | Acknowledged older answer overrides newer pending note | Pending latest note |
| Restarted answer retry, held reply | Older reply overrides newer pending note | Pending latest note, no older reply |
| Stale in-flight history read | Older replied ask changes a newly accepted note to Replied | Pending until the accepted note appears |
| Thread client reload | Accepted note identity disappears; older reply is shown | Identity retained until matching history appears |
| Uncertain landed Edit | Edit remains enabled | Exact attempted payload stays locked |
| Landed client and relay restart | Follow-up text restores as empty | Original words and request ID restore without automatic delivery |
| Unavailable tab persistence | Delivery occurs despite failed persistence | No delivery; visible error and retained words |

After implementation changes, the first broader focused run passed all ten retry regression tests and 163 of 164 total tests, exiting **1**. The existing receipt-label DOM test caught a provisional pending rule that obscured an acknowledged latest note when history omitted the older local receipt. The correction gives history order precedence when the local note is present and retains existing behavior for notes not yet listed.

The matching regression and focused compatibility run then exited **0**, with **164 passing tests and no failures**:

```sh
npm exec --yes --cache ./.quarterdeck-review-runtime-01M4JCQ710P23W7SSY5CT5JSKJ --package=node@24 -- node --test --test-reporter=dot prototype/test/receipt-retry-regressions.test.js prototype/test/call-lifecycle.test.js prototype/test/bearings-answer-form.test.js prototype/test/bearings-thread-panel.test.js prototype/test/bearings-landed-ui.test.js prototype/test/bearings-overview-tabs.test.js prototype/test/ui.test.js
```

The ten retry tests include all seven initially failing scenarios, plus first-attempt versus uncertain retry rejection, persistence before an in-flight response, and stale reads for pruned calls. The compatibility tests retain editor focus and selection, empty replies, phone tabs, In review status and Overview second mates. The temporary runtime cache was removed after verification.

The in-flight response test was then extended to send a new uncertain payload after reload and complete the destroyed controller's older response. Before adding the controller lifetime guard, the following command exited **1** with **one failing test**: the newer payload restored as empty instead of `New uncertain words`.

```sh
npm exec --yes --cache ./.quarterdeck-review-runtime-01M4JCQ710P23W7SSY5CT5JSKJ --package=node@24 -- node --test --test-name-pattern='persisted before its response' prototype/test/receipt-retry-regressions.test.js
```

After adding the controller lifetime guard, the identical 164-test focused command above exited **0** again, including the extended stale-response regression. The temporary runtime cache was removed after this final verification.

The upstream merge and both house features remain in scope: In review status and Overview second mates. Previously reported platform baseline failures remain unchanged: 12 prototype failures (ten onboarding and two preview lifecycle), 43 root health-check failures, and the local requested-360px/observed-500px browser assertion. Those suites are owned by the later pipeline phases and were not rerun here.
