import * as vscode from 'vscode';
import { findScriptBlocks } from './core/blocks';
import {
  DEFAULT_GLOBAL_SCRIPT_DIRS,
  ExternalDefinitions,
  GlobalScope,
} from './core/externals';
import { findEncodeEdits } from './core/encode';
import { DEFAULT_OPTIONS, LintOptions, lintDocument, Problem, RhinoFeature } from './core/lint';

const LANGUAGE_ID = 'birt-rptdesign';
const SOURCE = 'birt';

interface ExtensionOptions extends LintOptions {
  enabled: boolean;
  delay: number;
  globalScope: GlobalScope;
  globalScriptDirs: string[];
}

function readOptions(scope?: vscode.Uri): ExtensionOptions {
  const cfg = vscode.workspace.getConfiguration('birtRptdesign.lint', scope);
  return {
    enabled: cfg.get<boolean>('enabled', true),
    delay: cfg.get<number>('delay', 300),
    ecmaVersion: cfg.get<LintOptions['ecmaVersion']>('ecmaVersion', DEFAULT_OPTIONS.ecmaVersion),
    rhinoCompatibility: cfg.get<boolean>('rhinoCompatibility', DEFAULT_OPTIONS.rhinoCompatibility),
    rhinoUnsupported: cfg.get<RhinoFeature[]>('rhinoUnsupported', [...DEFAULT_OPTIONS.rhinoUnsupported]),
    undefinedGlobals: cfg.get<boolean>('undefinedGlobals', DEFAULT_OPTIONS.undefinedGlobals),
    extraGlobals: cfg.get<string[]>('extraGlobals', []),
    globalScope: cfg.get<GlobalScope>('globalScope', 'workspace'),
    globalScriptDirs: cfg.get<string[]>('globalScriptDirs', [...DEFAULT_GLOBAL_SCRIPT_DIRS]),
  };
}

/**
 * Resolves the globals that live in shared script libraries. Rebuilt whenever
 * the relevant settings change, and its cache dropped when a library is edited.
 */
class ExternalsProvider {
  private externals: ExternalDefinitions;

  constructor() {
    this.externals = this.build();
  }

  private build(): ExternalDefinitions {
    const options = readOptions();
    const roots = (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === 'file')
      .map((folder) => folder.uri.fsPath);
    return new ExternalDefinitions(
      options.globalScriptDirs,
      options.ecmaVersion,
      options.globalScope,
      roots,
    );
  }

  rebuild(): void {
    this.externals = this.build();
  }

  invalidate(): void {
    this.externals.clear();
  }

  forDocument(doc: vscode.TextDocument): ReadonlySet<string> | undefined {
    if (doc.uri.scheme !== 'file') return undefined;
    return this.externals.forFile(doc.uri.fsPath);
  }
}

function toDiagnostic(doc: vscode.TextDocument, problem: Problem): vscode.Diagnostic {
  const range = new vscode.Range(doc.positionAt(problem.start), doc.positionAt(problem.end));
  const diagnostic = new vscode.Diagnostic(
    range,
    problem.message,
    problem.severity === 'error'
      ? vscode.DiagnosticSeverity.Error
      : vscode.DiagnosticSeverity.Warning,
  );
  diagnostic.source = SOURCE;
  diagnostic.code = problem.code;
  return diagnostic;
}

function isReportDesign(doc: vscode.TextDocument): boolean {
  return doc.languageId === LANGUAGE_ID;
}

class Linter {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly diagnostics: vscode.DiagnosticCollection,
    private readonly externals: ExternalsProvider,
  ) {}

  run(doc: vscode.TextDocument): void {
    if (!isReportDesign(doc)) return;
    const options = readOptions(doc.uri);
    if (!options.enabled) {
      this.diagnostics.delete(doc.uri);
      return;
    }
    const problems = lintDocument(doc.getText(), {
      ...options,
      externalGlobals: options.undefinedGlobals ? this.externals.forDocument(doc) : undefined,
    });
    this.diagnostics.set(doc.uri, problems.map((p) => toDiagnostic(doc, p)));
  }

  schedule(doc: vscode.TextDocument): void {
    if (!isReportDesign(doc)) return;
    const key = doc.uri.toString();
    clearTimeout(this.timers.get(key));
    const delay = readOptions(doc.uri).delay;
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.run(doc);
      }, Math.max(0, delay)),
    );
  }

  forget(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    this.diagnostics.delete(doc.uri);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

interface OpenTag {
  tag: string;
  name?: string;
}

/**
 * For each offset (ascending), the nearest enclosing element that carries a
 * `name` attribute. One pass over the document, because a large report has
 * hundreds of script blocks and re-scanning per block is quadratic.
 */
function computeOwners(text: string, offsets: readonly number[]): Array<string | undefined> {
  const owners = new Array<string | undefined>(offsets.length);
  const stack: OpenTag[] = [];
  let next = 0;

  const nearestNamed = (): string | undefined => {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].name) return `${stack[i].tag} "${stack[i].name}"`;
    }
    return undefined;
  };

  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt === -1) break;
    while (next < offsets.length && offsets[next] <= lt) owners[next++] = nearestNamed();

    // Markup inside CDATA and comments is text, not structure.
    if (text.startsWith('<![CDATA[', lt)) {
      const close = text.indexOf(']]>', lt);
      i = close === -1 ? text.length : close + 3;
      continue;
    }
    if (text.startsWith('<!--', lt)) {
      const close = text.indexOf('-->', lt);
      i = close === -1 ? text.length : close + 3;
      continue;
    }
    if (text.startsWith('<?', lt) || text.startsWith('<!', lt)) {
      const close = text.indexOf('>', lt);
      i = close === -1 ? text.length : close + 1;
      continue;
    }

    const gt = text.indexOf('>', lt);
    if (gt === -1) break;
    const raw = text.slice(lt + 1, gt);

    if (raw.startsWith('/')) {
      const tag = /^\/\s*([\w:.-]+)/.exec(raw)?.[1];
      if (tag) {
        for (let k = stack.length - 1; k >= 0; k--) {
          if (stack[k].tag === tag) {
            stack.length = k;
            break;
          }
        }
      }
    } else if (!raw.endsWith('/')) {
      const tag = /^([\w:.-]+)/.exec(raw)?.[1];
      if (tag) stack.push({ tag, name: /\bname="([^"]*)"/.exec(raw)?.[1] });
    }
    i = gt + 1;
  }

  while (next < offsets.length) owners[next++] = nearestNamed();
  return owners;
}

/** Outline entries for every script block, labelled with the element they belong to. */
const symbolProvider: vscode.DocumentSymbolProvider = {
  provideDocumentSymbols(doc) {
    const text = doc.getText();
    const blocks = findScriptBlocks(text);
    const owners = computeOwners(text, blocks.map((b) => b.elementStart));

    return blocks.map((block, i) => {
      const range = new vscode.Range(
        doc.positionAt(block.elementStart),
        doc.positionAt(block.contentEnd),
      );
      const selection = new vscode.Range(
        doc.positionAt(block.contentStart),
        doc.positionAt(block.contentStart),
      );
      const symbol = new vscode.DocumentSymbol(
        block.name,
        owners[i] ?? block.kind,
        block.kind === 'method' ? vscode.SymbolKind.Method : vscode.SymbolKind.Variable,
        range,
        selection,
      );
      return symbol;
    });
  },
};

/** Edits that bring a document's CDATA escaping in line with BIRT Designer. */
function encodeEdits(doc: vscode.TextDocument): vscode.TextEdit[] {
  return findEncodeEdits(doc.getText()).map((edit) =>
    vscode.TextEdit.replace(
      new vscode.Range(doc.positionAt(edit.start), doc.positionAt(edit.end)),
      edit.replacement,
    ),
  );
}

function encodeOnSaveEnabled(uri: vscode.Uri): boolean {
  return vscode.workspace
    .getConfiguration('birtRptdesign', uri)
    .get<boolean>('encodeEntitiesOnSave', true);
}

export function activate(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection(SOURCE);
  const externals = new ExternalsProvider();
  const linter = new Linter(diagnostics, externals);

  const libraryWatcher = vscode.workspace.createFileSystemWatcher('**/*.{js,rptlibrary}');
  const onLibraryChange = () => {
    externals.invalidate();
    for (const doc of vscode.workspace.textDocuments) linter.schedule(doc);
  };
  libraryWatcher.onDidChange(onLibraryChange);
  libraryWatcher.onDidCreate(onLibraryChange);
  libraryWatcher.onDidDelete(onLibraryChange);

  context.subscriptions.push(diagnostics, libraryWatcher, { dispose: () => linter.dispose() });

  for (const doc of vscode.workspace.textDocuments) linter.run(doc);

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => linter.run(doc)),
    vscode.workspace.onDidChangeTextDocument((e) => linter.schedule(e.document)),
    vscode.workspace.onDidSaveTextDocument((doc) => linter.run(doc)),
    vscode.workspace.onDidCloseTextDocument((doc) => linter.forget(doc)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('birtRptdesign.lint')) return;
      externals.rebuild();
      for (const doc of vscode.workspace.textDocuments) linter.run(doc);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => externals.rebuild()),
    vscode.languages.registerDocumentSymbolProvider({ language: LANGUAGE_ID }, symbolProvider),
    vscode.languages.registerDocumentFormattingEditProvider(
      { language: LANGUAGE_ID },
      { provideDocumentFormattingEdits: (doc) => encodeEdits(doc) },
    ),
    vscode.workspace.onWillSaveTextDocument((e) => {
      if (!isReportDesign(e.document) || !encodeOnSaveEnabled(e.document.uri)) return;
      e.waitUntil(Promise.resolve(encodeEdits(e.document)));
    }),
    vscode.commands.registerCommand('birtRptdesign.encodeEntities', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !isReportDesign(editor.document)) {
        vscode.window.showWarningMessage('Open a BIRT report design first.');
        return;
      }
      const edits = encodeEdits(editor.document);
      if (edits.length === 0) {
        vscode.window.showInformationMessage('Script escaping already matches BIRT Designer.');
        return;
      }
      await editor.edit((builder) => {
        for (const edit of edits) builder.replace(edit.range, edit.newText);
      });
      vscode.window.showInformationMessage(`Encoded ${edits.length} character(s).`);
    }),
    vscode.commands.registerCommand('birtRptdesign.lintWorkspace', () =>
      lintWorkspace(diagnostics, externals),
    ),
  );
}

async function lintWorkspace(
  diagnostics: vscode.DiagnosticCollection,
  externals: ExternalsProvider,
): Promise<void> {
  const files = await vscode.workspace.findFiles(
    '**/*.{rptdesign,rpttemplate,rptlibrary}',
    '**/node_modules/**',
  );

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Linting BIRT report designs' },
    async (progress) => {
      let problemCount = 0;
      let fileCount = 0;
      let done = 0;
      for (const uri of files) {
        done += 1;
        const options = readOptions(uri);
        if (!options.enabled) continue;
        const doc = await vscode.workspace.openTextDocument(uri);
        const problems = lintDocument(doc.getText(), {
          ...options,
          externalGlobals: options.undefinedGlobals ? externals.forDocument(doc) : undefined,
        });
        diagnostics.set(uri, problems.map((p) => toDiagnostic(doc, p)));
        if (problems.length > 0) {
          problemCount += problems.length;
          fileCount += 1;
        }
        progress.report({ message: `${done}/${files.length}` });
      }
      vscode.window.showInformationMessage(
        problemCount === 0
          ? `No problems found in ${files.length} report design file(s).`
          : `${problemCount} problem(s) in ${fileCount} of ${files.length} report design file(s).`,
      );
    },
  );
}

export function deactivate(): void {
  /* diagnostics are disposed through the subscription list */
}
