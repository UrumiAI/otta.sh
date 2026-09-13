---
"@otta-sh/admin-react": patch
---

Move the EmDash host pin from 0.31.1 to the 0.37 line: the `emdash` peer moved to exact
`0.37.0`; the repo builds and tests against a vendored `0.37.1-otta.1` build of that release
line carrying the conditional-write primitives. Block Kit is unchanged between 0.31.1 and
0.37 — the package's rendered output is byte-for-byte the same — so this is a
dependency-range change only, with no behavioural change to the console.
