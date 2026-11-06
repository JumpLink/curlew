# Fixing gjsify gaps at the core

gjsify is a first-party dependency, not vendored third-party code. If a capability is missing or broken there, fix it in the `gjsify/gjsify` submodule with a test and let curlew pick it up via a version bump — do not paper over it here.

## Shim markers

A shim that is unavoidable meanwhile carries **one of two markers, and they mean opposite things at bump time**:

- `// fixed upstream in gjsify: …` — the fix has LANDED. Delete the shim at the next bump.
- `// gjsify gap (unfixed, <PR>): …` — no upstream fix exists yet. The shim is **load-bearing**; leave it however redundant it looks.

## Neither marker is a substitute for measuring

`download.ts` carried three of the second kind against gjsify#1035; the fix arrived as #1039 instead, so the marker named a PR that was still open while the behaviour it described had already changed. A bump re-measures the behaviour and believes the result, not the note — that is a four-line probe, and it is how those three shims came out in 0.32.0.

## MCP runtime

The MCP runtime is upstream and that extraction is DONE. `runtime.ts` was the extraction candidate; at 0.54.0 it **is** `@gjsify/mcp`, and troedler's verbatim second copy is gone with it. Nothing was re-implemented on the way in — same bodies, same signatures — so no client surface moved: `tools/list`, a read-only `tools/call` and the error path are byte-identical against the two bundles. `types.ts` stays for `mcpErrorFrom` alone, which is genuinely curlew's (it routes a `GnomeError` through `describeUnavailable`; the package's generic one cannot know that).

The tests did NOT move with the code: `gate.test.ts` and the two canaries import the gate from the package and keep pinning the fail-closed direction, because a gate this repo does not own is the one case where "it was tested here once" stops being evidence.
