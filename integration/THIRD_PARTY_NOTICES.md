# Third-party notices

The distributed plugin uses DeepSeek Harness through public plugin contracts.
It does not embed the host workspace UI, clsx, or a host source patch. Its
runtime `yaml` dependency is distributed separately by npm under its own ISC
license. Original plugin code outside the separately licensed LLM Wiki program
is covered by the root `LICENSE`.

## Workforce role skills

The concise Chinese role and stage instructions under `skills/` are independently
written DSH adaptations covered by the root MIT license. Common workflow names
such as `to-spec`, `code-review`, and `pr` describe their purpose; these files are
not verbatim distributions of global Codex skills. They do not include the
upstream UI/UX search database or a multi-agent spec implementation orchestrator.
`design-system-guidance` is the separate lightweight design reference. The
zero-dependency worktree helper is package-owned and removes only task-created,
merged temporary checkouts with explicit preservation checks.

## Shared LLM Wiki program

Source: <https://github.com/nashsu/llm_wiki>, version `0.6.13`, commit
`e08cfce65aad8b76b13546a081c1a8d4422b70c3`.

LLM Wiki — Copyright (C) 2024–2026 Yong Su.

The selected upstream modules, integration bridge and separate browser program
under `third_party/llm-wiki/` are provided under GNU General Public License
version 3. The upstream license and copyright notice are preserved in
`third_party/llm-wiki/LICENSE`. Integration changes are dated 2026-10-24 and
recorded with the selected-source inventory in that directory. The root MIT
license does not replace this program's GPL terms.

The main graph uses evidence-backed concepts/entities and semantic relations
from the authorized knowledge snapshot. It reuses the upstream Louvain community
implementation on that semantic graph, and its analysis prompt during knowledge
compilation. Original page-network and four-signal relevance modules remain in
the corresponding-source inventory for provenance; their document-link scores
do not determine the main graph. The integration supplies a read-only Markdown
page projection, a JSON process boundary and a separate sandboxed graph-and-reader
page. Sources, synthesis articles and the overview remain available for reading
and citation tracing outside the main graph. It does not distribute or start the upstream
Tauri desktop application, Rust agent, updater, credential store, MCP server,
web research services or clipboard watcher.

The GPL program is built separately into `lib/llm-wiki/`; it is not bundled into
the host application or the primary plugin UI. A single packaged program serves
all authorized employee/team spaces. Separate process and iframe boundaries
describe the implementation and do not change the license of copied or modified
upstream code.

Distribution must include the exact corresponding source for the delivered GPL
program: selected upstream sources, all bridge/browser modifications, protocol
definitions, dependency manifest/lock and build instructions/scripts. These are
delivered beside the object code in the npm archive; an upstream repository URL
alone is not a substitute for the source of our modified version. The archive
inventory and executable/source hashes must be checked during release
acceptance. The selected program's dependency notices are preserved alongside
its source and build outputs.

Knowledge context retention calls the public DeepSeek Harness Session surface
replacement protocol and imports the public token-meter estimate module as an
external runtime peer. `@deepseek-ai/dsh-token-meter` and
`@deepseek-ai/dsh-compaction` version `0.2.2-rc.1` remain supplied by the host
profile; their MIT-licensed implementation is not embedded or patched here.

The notice below is retained for the historical integration patch in the source
repository. That patch is excluded from the npm archive and must not be applied
to prepare a current installation.

## DeepSeek Harness integration patch

Source: <https://github.com/deepseek-ai/deepseek-harness>, commit
`d743267388641bc76f17c45ce8b4c231aed1d32c`, `packages/client/ui-workspace/src`.
Modified to add generic, additive workspace header and menu extension slots.

MIT License

Copyright (c) 2026 DeepSeek

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
