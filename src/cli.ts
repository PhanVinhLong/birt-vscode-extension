#!/usr/bin/env node
/**
 * Command-line form of the same checks the extension runs, so CI can fail a
 * merge request on a broken script instead of waiting for a BIRT run.
 *
 *   node dist/cli.js [--no-rhino] [--undefined-globals] [--ecma 2020] <paths...>
 */
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_OPTIONS, LintOptions, lintDocument, RhinoFeature } from './core/lint';
import { applyEdits, findEncodeEdits } from './core/encode';
import { DEFAULT_GLOBAL_SCRIPT_DIRS, ExternalDefinitions, GlobalScope } from './core/externals';

const EXTENSIONS = new Set(['.rptdesign', '.rpttemplate', '.rptlibrary']);

function collectFiles(target: string, out: string[]): void {
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) {
      if (entry === 'node_modules' || entry === '.git') continue;
      collectFiles(path.join(target, entry), out);
    }
  } else if (EXTENSIONS.has(path.extname(target))) {
    out.push(target);
  }
}

/** Offset -> 1-based line/column, matching what editors show. */
function lineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

function main(argv: string[]): number {
  const options: LintOptions = { ...DEFAULT_OPTIONS };
  const targets: string[] = [];
  let globalScope: GlobalScope = 'workspace';
  let fixEncoding = false;
  let checkEncoding = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-rhino') options.rhinoCompatibility = false;
    else if (arg === '--undefined-globals') options.undefinedGlobals = true;
    else if (arg === '--global-scope') globalScope = argv[++i] as GlobalScope;
    else if (arg === '--fix-encoding') fixEncoding = true;
    else if (arg === '--check-encoding') checkEncoding = true;
    else if (arg === '--ecma') options.ecmaVersion = Number(argv[++i]) as LintOptions['ecmaVersion'];
    else if (arg === '--rhino-unsupported') {
      options.rhinoUnsupported = argv[++i].split(',') as RhinoFeature[];
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: birt-lint [--no-rhino] [--undefined-globals] [--ecma <version>] ' +
          '[--rhino-unsupported a,b,c] [--global-scope workspace|nearest]\n' +
          '                 [--check-encoding] [--fix-encoding] <files-or-directories...>\n',
      );
      return 0;
    } else if (arg.startsWith('-')) {
      process.stderr.write(`Unknown option: ${arg}\n`);
      return 2;
    } else {
      targets.push(arg);
    }
  }

  if (targets.length === 0) targets.push('.');

  const files: string[] = [];
  for (const target of targets) collectFiles(target, files);
  files.sort();

  if (fixEncoding || checkEncoding) {
    let touched = 0;
    let characters = 0;
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const edits = findEncodeEdits(text);
      if (edits.length === 0) continue;
      touched += 1;
      characters += edits.length;
      if (fixEncoding) fs.writeFileSync(file, applyEdits(text, edits), 'utf8');
      else {
        const { line, column } = lineColumn(text, edits[0].start);
        process.stdout.write(
          `${file}:${line}:${column}: ${edits.length} character(s) not escaped the way BIRT Designer writes them\n`,
        );
      }
    }
    process.stdout.write(
      fixEncoding
        ? `\nEncoded ${characters} character(s) in ${touched} of ${files.length} file(s).\n`
        : `\n${characters} character(s) in ${touched} of ${files.length} file(s) need encoding.\n`,
    );
    return checkEncoding && touched > 0 ? 1 : 0;
  }

  let errors = 0;
  let warnings = 0;
  const externals = new ExternalDefinitions(
    DEFAULT_GLOBAL_SCRIPT_DIRS,
    options.ecmaVersion,
    globalScope,
    targets.map((t) => path.resolve(t)),
  );

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const perFile: LintOptions = options.undefinedGlobals
      ? { ...options, externalGlobals: externals.forFile(path.resolve(file)) }
      : options;
    for (const problem of lintDocument(text, perFile)) {
      const { line, column } = lineColumn(text, problem.start);
      const stream = problem.severity === 'error' ? process.stderr : process.stdout;
      stream.write(`${file}:${line}:${column}: ${problem.severity}: ${problem.message} [${problem.code}]\n`);
      if (problem.severity === 'error') errors += 1;
      else warnings += 1;
    }
  }

  process.stdout.write(
    `\nChecked ${files.length} file(s): ${errors} error(s), ${warnings} warning(s).\n`,
  );
  return errors > 0 ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
