# BIRT Report Design — VS Code extension

Syntax highlighting and JavaScript linting for the script blocks embedded in
BIRT `.rptdesign` / `.rpttemplate` / `.rptlibrary` files.

A report design is XML, but most of the logic lives in JavaScript inside
`<method>` and `<expression>` elements. Without this extension those blocks are
one undifferentiated grey block of text, and a syntax error only shows up when
BIRT runs the report.

## What it does

**Highlighting.** The XML is coloured as XML; the JavaScript inside
`<method>`, `<expression>` and `<value-of>` is coloured as JavaScript, with
bracket matching and `Ctrl+/` commenting working inside the script blocks.

**Diagnostics.** Every script block is parsed and problems appear in the
Problems panel, squiggled at the right place in the file:

| Check | Severity | Default |
| --- | --- | --- |
| JavaScript syntax errors | error | on |
| Constructs BIRT's Rhino engine may not support | warning | on |
| Identifiers never declared, assigned or imported | warning | off |

**Encoding on save.** Script blocks are re-escaped the way BIRT Designer
writes them, so hand-edited files stop drifting from designer-written ones.

**Outline.** Every script block appears in the outline / `Ctrl+Shift+O`,
labelled with the report element that owns it.

**CLI.** The same checks run headlessly, for CI.

## The entity quirk

BIRT Designer XML-escapes `&` and `<` *inside* CDATA sections. A condition
written in the designer as

```js
motive != null && motive != ""
```

is stored in the file as

```xml
<![CDATA[motive != null &amp;&amp; motive != ""]]>
```

A plain JavaScript parser pointed at the raw CDATA fails on roughly a fifth of
real-world methods for that reason alone. The extension entity-decodes each block before
parsing, and maps parser offsets back through the decoding so diagnostics land
on the correct line and column. Entities are also coloured distinctly from the
surrounding code, so `&amp;&amp;` still reads as an operator.

## Encoding on save

BIRT Designer escapes `&` as `&amp;` *inside* CDATA and decodes it again when
it loads the report, so `a && b` is stored as `a &amp;&amp; b`. Editing a
report in a plain text editor breaks that convention, and the difference shows
up as churn the next time someone saves the file from the designer.

On save, the extension escapes any `&` in `<method>` and `<text-property>`
CDATA that is not already part of an entity reference. Set
`birtRptdesign.encodeEntitiesOnSave` to `false` to turn it off; the same fix is
available on demand as **BIRT: Encode script characters the way BIRT Designer
does**, and as the document formatter, so `Format Document` applies it too.

What is deliberately *not* touched:

- `<`, `>` and `"` inside CDATA. BIRT leaves those raw — in a 171-file
  production corpus, every one of the ~25,000 `<` and `>` characters inside
  CDATA is unescaped — and escaping them would be a large, pointless diff.
- Plain XML text such as `<expression>`. A raw `&` or `<` there would make the
  file malformed, so it is already correct in any file an XML parser accepts.

The transformation only ever replaces one `&` with `&amp;`, so it is
idempotent and leaves the decoded JavaScript byte-identical. Verified against a
171-file production corpus: 60 characters in 14 files were re-encoded, every
file stayed well-formed, all 1,886 decoded script blocks were unchanged, and a
second pass found nothing left to do.

To normalise a whole project in one go rather than file by file on save:

```sh
birt-lint --fix-encoding .
```

`--check-encoding` reports what would change and exits non-zero instead, which
makes it usable as a CI gate.

## Install

From the Marketplace, search for **BIRT Report Design**. To build it yourself:

```sh
git clone https://github.com/PhanVinhLong/birt-vscode-extension.git
cd birt-vscode-extension
npm install
npm run build
npx @vscode/vsce package --no-dependencies
code --install-extension birt-rptdesign-0.1.0.vsix
```

Reload the window afterwards. Files with a `.rptdesign`, `.rpttemplate` or
`.rptlibrary` extension pick up the new language automatically.

For day-to-day development, `npm run watch` plus the **Run Extension** launch
target (F5) is quicker than repackaging.

## CLI

```sh
node dist/cli.js /path/to/your/birt/project
```

Exits non-zero if any script has a syntax error, so it can gate a merge
request:

```yaml
lint:birt-scripts:
  image: node:20
  script:
    - npm ci && npm run build
    - node dist/cli.js .
```

(`dist/` is gitignored, so CI builds it first.)

Options:

| Flag | Effect |
| --- | --- |
| `--no-rhino` | Skip the Rhino compatibility warnings |
| `--undefined-globals` | Also report identifiers that are never defined |
| `--ecma <version>` | Parser ECMAScript version (default `2020`) |
| `--rhino-unsupported a,b,c` | Which constructs the Rhino check reports |
| `--global-scope workspace\|nearest` | How shared script libraries are resolved |
| `--check-encoding` | Report script blocks not escaped the BIRT way; exit non-zero |
| `--fix-encoding` | Rewrite those files in place |

## Settings

All under `birtRptdesign.lint`:

- `enabled` — master switch for diagnostics.
- `ecmaVersion` (default `2020`) — how permissively scripts are parsed. Keep
  this permissive and let the Rhino check flag what the engine cannot run;
  lowering it to `5` turns those warnings into hard parse errors instead.
- `rhinoCompatibility` / `rhinoUnsupported` — see below.
- `undefinedGlobals` (default `false`), `extraGlobals` — see below.
- `globalScope`, `globalScriptDirs` — where shared globals are resolved from.
- `delay` — debounce in milliseconds while typing.

And one outside it:

- `birtRptdesign.encodeEntitiesOnSave` (default `true`) — see
  [Encoding on save](#encoding-on-save).

### Rhino compatibility

BIRT runs report scripts on Rhino, not on a modern JavaScript engine, so code
that is fine in the editor can fail at report-generation time. The check warns
on arrow functions, template literals, classes, spread/rest, destructuring,
default parameters, `for...of`, `async`/`await`, generators, optional chaining,
nullish coalescing and `**`.

**The default list is a conservative guess, not a reading of your engine.**
Which constructs actually work depends on the Rhino version bundled with your
BIRT runtime — newer ones support a fair amount of ES6. `let`/`const` is
deliberately left out of the default list because Rhino has supported it for a
long time. Confirm against your deployed BIRT version and trim
`rhinoUnsupported` accordingly; an over-eager list is just noise.

### Undefined globals

BIRT scripts share one global scope: `initialize` assigns `PARAGRAPHE_1` and
`beforeFactory` reads it, with no declaration anywhere. The check therefore
treats as defined anything declared *or assigned* in any block of the same
file, plus known JavaScript and BIRT globals, plus top-level declarations in
the shared script libraries found via `globalScriptDirs`.

It is off by default because `.rptlibrary` files are inherently noisy under it:
a library reads variables that the *consuming report* is expected to set, which
no amount of static resolution can discover. On report files it is much
quieter and does find real problems. Turn it on, read what it says about your
reports, and add anything legitimately external to `extraGlobals`.

A block with a syntax error contributes no definitions, so a single parse error
can produce a burst of undefined-global warnings elsewhere in the file. Fix the
syntax error first.

## Scope and limitations

- Syntax, not semantics: this will not catch `null` dereferences, wrong
  argument counts or typos in `params["..."]` string keys.
- The XML itself is not validated — no well-formedness or schema checking.
- Script blocks are located with regular expressions rather than a full XML
  parse. That is fine for designer-generated files; a `</method>` inside a
  JavaScript string literal would confuse it.
- `<text-property name="content">` HTML is not highlighted as HTML, only the
  `<value-of>` scripts inside it.

## Layout

```
src/core/blocks.ts      script extraction, entity decoding, offset mapping
src/core/lint.ts        acorn parse, Rhino check, undefined-globals check
src/core/encode.ts      BIRT-compatible re-escaping of CDATA script blocks
src/core/externals.ts   globals resolved from shared .js / .rptlibrary files
src/core/globals.ts     known JavaScript and BIRT global names
src/extension.ts        VS Code wiring: diagnostics, outline, commands
src/cli.ts              headless entry point for CI
syntaxes/               TextMate grammars
```

`src/core` has no dependency on the `vscode` module, which is what lets the
editor and the CLI run exactly the same checks.

## Contributing

Issues and pull requests are welcome. `npm run typecheck` and `npm run build`
should both pass; `src/core` must stay free of any `vscode` import so the CLI
keeps working.

## License

MIT — see [LICENSE](LICENSE).
