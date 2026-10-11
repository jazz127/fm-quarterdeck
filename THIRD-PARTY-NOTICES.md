# Attribution and third-party boundaries

Quarterdeck's own source is offered under the [MIT License](LICENSE), attributed to Quarterdeck contributors. That attribution does not claim that Kun Chen or Kunchenguid owns or licenses Quarterdeck, or that upstream maintainers endorse this project. The repository owner is its initial maintainer, not the licensor of unrelated upstream work.

- **Firstmate / Kunchenguid:** Quarterdeck integrates with and references Firstmate and its tools. Firstmate's public posture informed the preview-stage governance structure; project-specific workflow and CI claims are not imported. Public tool owner identifiers (including `kunchenguid` in toolcheck's scope checks) are intentional attribution and safety contracts. Upstream reference: <https://github.com/kunchenguid/firstmate>. No upstream license, trademark or affiliation is transferred by that link.
- **Provider names:** quota/billing labels identify their actual data providers. Neutral text/first-letter monograms replace the former provider drawings; no provider logo files or brand-color mappings are shipped. Names/marks belong to their respective owners; their appearance does not imply sponsorship.
- **Dependencies/platforms:** Node, Python, Git and npm dependencies retain their own licenses and notices. Package manifests/lockfiles identify dependencies; the project MIT license does not relicense third-party software. Preserve applicable upstream notices when separately bundling dependencies. This source preview does not bundle installed packages or account tools.

## Web Push standards library

`prototype/package.json` pins [`web-push` 3.6.7](https://github.com/web-push-libs/web-push), licensed under [MPL-2.0](https://github.com/web-push-libs/web-push/blob/v3.6.7/LICENSE). It owns RFC 8291 payload encryption and RFC 8292 VAPID signatures. Its source is consumed as a package without modification; no installed dependency code is bundled in this repository. Preserve its license and transitive dependency notices when distributing installed packages. Exact resolved versions and integrity hashes are in `prototype/package-lock.json`.

## lavish-axi capture helpers

`prototype/public/review-target.js` adapts the selector, text-range boundary and table-cell capture patterns from lavish-axi 0.1.78 (<https://github.com/kunchenguid/lavish-axi>), with Quarterdeck-specific stop points and bounded context. Upstream license:

```text
MIT License

Copyright (c) 2026 Kun Chen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

No external rights verification or general legal/dependency audit is claimed. New third-party artwork or copied source requires explicit provenance and license review before inclusion.
