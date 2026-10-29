# Changelog

## 0.1.0

First release.

- Syntax highlighting for JavaScript embedded in `<method>`, `<expression>` and
  `<value-of>` elements, with XML entities inside script blocks coloured
  distinctly from the surrounding code.
- Diagnostics: JavaScript syntax errors, warnings for constructs BIRT's Rhino
  engine may not support, and an opt-in check for identifiers that are never
  declared, assigned or imported.
- Outline entries for every script block, labelled with the element that owns
  it.
- On save, re-escapes `&` inside CDATA the way BIRT Designer writes it.
- A CLI (`dist/cli.js`) that runs the same checks headlessly for CI.
