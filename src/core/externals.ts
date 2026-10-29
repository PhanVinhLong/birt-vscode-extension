/**
 * Names that a report can use without declaring them, because BIRT loads them
 * from somewhere else: the shared `.js` script libraries registered with the
 * report engine, and the `.rptlibrary` files a report includes.
 *
 * Resolution walks up from the report towards the workspace root and uses the
 * nearest ancestor that actually contains one of the configured directories,
 * so a report resolves against its own project's scripts, not a sibling's.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as acorn from 'acorn';
import { findScriptBlocks } from './blocks';

const SCRIPT_EXTENSIONS = new Set(['.js', '.rptlibrary']);

export const DEFAULT_GLOBAL_SCRIPT_DIRS = ['resources/birt/scripts', 'resources/birt/libraries'];

/** Top-level declarations and bare assignments, i.e. what leaks into the global scope. */
function topLevelNames(code: string, ecmaVersion: acorn.ecmaVersion, out: Set<string>): void {
  let program: any;
  try {
    program = acorn.parse(code, {
      ecmaVersion,
      sourceType: 'script',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
    });
  } catch {
    return; // a broken library is reported when that file itself is linted
  }

  for (const node of program.body as any[]) {
    if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
      if (node.id) out.add(node.id.name);
    } else if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations) {
        if (d.id?.type === 'Identifier') out.add(d.id.name);
      }
    } else if (
      node.type === 'ExpressionStatement' &&
      node.expression?.type === 'AssignmentExpression' &&
      node.expression.left?.type === 'Identifier'
    ) {
      out.add(node.expression.left.name);
    }
  }
}

function walkDir(dir: string, out: string[], depth = 0): void {
  if (depth > 8) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walkDir(full, out, depth + 1);
    } else if (SCRIPT_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
}

/** Every directory under `root` whose path ends with one of `relativeDirs`. */
function findScriptRootsInTree(root: string, relativeDirs: readonly string[], depth = 0): string[] {
  if (depth > 10) return [];
  const suffixes = relativeDirs.map((rel) => path.sep + rel.split('/').join(path.sep));
  const found: string[] = [];

  const visit = (dir: string, d: number): void => {
    if (d > 10) return;
    if (suffixes.some((suffix) => dir.endsWith(suffix))) {
      found.push(dir);
      return; // its contents are collected wholesale by walkDir
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      visit(path.join(dir, entry.name), d + 1);
    }
  };

  visit(path.resolve(root), depth);
  return found;
}

/** The nearest ancestor of `fromDir` that contains at least one of `relativeDirs`. */
function findScriptRoots(fromDir: string, relativeDirs: readonly string[], stopAt?: string): string[] {
  let dir = path.resolve(fromDir);
  const stop = stopAt ? path.resolve(stopAt) : undefined;

  for (;;) {
    const hits = relativeDirs
      .map((rel) => path.join(dir, rel))
      .filter((candidate) => {
        try {
          return fs.statSync(candidate).isDirectory();
        } catch {
          return false;
        }
      });
    if (hits.length > 0) return hits;

    const parent = path.dirname(dir);
    if (parent === dir) return [];
    if (stop && dir === stop) return [];
    dir = parent;
  }
}

/**
 * `workspace` pools every script directory in the project, which mirrors the
 * single global scope BIRT's engine builds from its configured script
 * libraries - reports in one region do call helpers that live in another.
 * `nearest` restricts resolution to the closest ancestor, which catches more
 * typos but reports cross-region calls as unknown.
 */
export type GlobalScope = 'workspace' | 'nearest';

export class ExternalDefinitions {
  private readonly cache = new Map<string, ReadonlySet<string>>();

  constructor(
    private readonly relativeDirs: readonly string[] = DEFAULT_GLOBAL_SCRIPT_DIRS,
    private readonly ecmaVersion: acorn.ecmaVersion = 2020,
    private readonly scope: GlobalScope = 'workspace',
    private readonly workspaceRoots: readonly string[] = [],
  ) {}

  /** Global names visible to the report at `filePath`. */
  forFile(filePath: string): ReadonlySet<string> {
    const roots =
      this.scope === 'workspace' && this.workspaceRoots.length > 0
        ? this.workspaceRoots.flatMap((root) => findScriptRootsInTree(root, this.relativeDirs))
        : findScriptRoots(path.dirname(filePath), this.relativeDirs);
    if (roots.length === 0) return new Set();

    const key = roots.join(path.delimiter);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const names = new Set<string>();
    const files: string[] = [];
    for (const root of roots) walkDir(root, files);

    for (const file of files) {
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (path.extname(file) === '.js') {
        topLevelNames(text, this.ecmaVersion, names);
      } else {
        // A .rptlibrary holds the same kind of script blocks a report does.
        for (const block of findScriptBlocks(text)) {
          if (block.kind === 'method') topLevelNames(block.code, this.ecmaVersion, names);
        }
      }
    }

    this.cache.set(key, names);
    return names;
  }

  clear(): void {
    this.cache.clear();
  }
}
