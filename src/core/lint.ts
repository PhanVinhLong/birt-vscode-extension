import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { findScriptBlocks, ScriptBlock } from './blocks';
import { BIRT_GLOBALS, JS_GLOBALS } from './globals';

export type Severity = 'error' | 'warning';

export interface Problem {
  severity: Severity;
  message: string;
  /** Document offsets. */
  start: number;
  end: number;
  /** Stable id used for the diagnostic code, e.g. `syntax`, `rhino/arrow-function`. */
  code: string;
  block: ScriptBlock;
}

export type RhinoFeature =
  | 'arrow-function' | 'template-literal' | 'class' | 'spread' | 'destructuring'
  | 'default-parameter' | 'for-of' | 'async-await' | 'generator'
  | 'optional-chaining' | 'nullish-coalescing' | 'exponent-operator' | 'let-const';

export interface LintOptions {
  ecmaVersion: acorn.ecmaVersion;
  rhinoCompatibility: boolean;
  rhinoUnsupported: readonly RhinoFeature[];
  undefinedGlobals: boolean;
  extraGlobals: readonly string[];
  /** Names resolved from shared script libraries; see `ExternalDefinitions`. */
  externalGlobals?: ReadonlySet<string>;
}

export const DEFAULT_OPTIONS: LintOptions = {
  ecmaVersion: 2020,
  rhinoCompatibility: true,
  rhinoUnsupported: [
    'arrow-function', 'template-literal', 'class', 'spread', 'destructuring',
    'default-parameter', 'for-of', 'async-await', 'generator',
    'optional-chaining', 'nullish-coalescing', 'exponent-operator',
  ],
  undefinedGlobals: false,
  extraGlobals: [],
};

const FEATURE_LABELS: Record<RhinoFeature, string> = {
  'arrow-function': 'Arrow function',
  'template-literal': 'Template literal',
  class: 'Class declaration',
  spread: 'Spread/rest syntax',
  destructuring: 'Destructuring',
  'default-parameter': 'Default parameter value',
  'for-of': '`for...of` loop',
  'async-await': '`async`/`await`',
  generator: 'Generator function',
  'optional-chaining': 'Optional chaining (`?.`)',
  'nullish-coalescing': 'Nullish coalescing (`??`)',
  'exponent-operator': 'Exponent operator (`**`)',
  'let-const': '`let`/`const` declaration',
};

/** Translate a decoded offset back into a document offset. */
function toDoc(block: ScriptBlock, offset: number): number {
  const i = Math.max(0, Math.min(offset, block.map.length - 1));
  return block.map[i];
}

function parse(block: ScriptBlock, ecmaVersion: acorn.ecmaVersion): acorn.Node {
  const options: acorn.Options = {
    ecmaVersion,
    sourceType: 'script',
    // Method bodies are spliced into a generated function, so a bare `return`
    // at the top level is legal BIRT.
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowHashBang: false,
    locations: false,
  };

  if (!block.isExpression) return acorn.parse(block.code, options);

  // An expression such as `{ a: 1 }` parses as a block statement when read as
  // a program, so try the expression grammar first and fall back.
  try {
    const node = acorn.parseExpressionAt(block.code, 0, options);
    // parseExpressionAt stops at the first complete expression; if there is
    // meaningful text left, the block is really a sequence of statements.
    if (block.code.slice(node.end).trim() === '') return node;
  } catch {
    // fall through to the program parse, whose error is more informative
  }
  return acorn.parse(block.code, options);
}

function describeBlock(block: ScriptBlock): string {
  return block.kind === 'method' ? `method "${block.name}"` : `${block.kind} "${block.name}"`;
}

function checkSyntax(block: ScriptBlock, options: LintOptions, out: Problem[]): acorn.Node | undefined {
  try {
    return parse(block, options.ecmaVersion);
  } catch (err) {
    const e = err as Error & { pos?: number; raisedAt?: number };
    const pos = typeof e.pos === 'number' ? e.pos : 0;
    const raisedAt = typeof e.raisedAt === 'number' ? e.raisedAt : pos + 1;
    // acorn appends "(line:column)" using its own coordinates, which do not
    // match the document once the surrounding XML is taken into account.
    const message = String(e.message).replace(/\s*\(\d+:\d+\)\s*$/, '');
    out.push({
      severity: 'error',
      message: `${message} (in ${describeBlock(block)})`,
      start: toDoc(block, pos),
      end: toDoc(block, Math.max(raisedAt, pos + 1)),
      code: 'syntax',
      block,
    });
    return undefined;
  }
}

interface FeatureHit {
  feature: RhinoFeature;
  start: number;
  end: number;
}

function collectRhinoFeatures(ast: acorn.Node): FeatureHit[] {
  const hits: FeatureHit[] = [];
  const add = (feature: RhinoFeature, node: acorn.Node) =>
    hits.push({ feature, start: node.start, end: node.end });

  walk.full(ast, (node: any) => {
    switch (node.type) {
      case 'ArrowFunctionExpression':
        add('arrow-function', node);
        break;
      case 'TemplateLiteral':
      case 'TaggedTemplateExpression':
        add('template-literal', node);
        break;
      case 'ClassDeclaration':
      case 'ClassExpression':
        add('class', node);
        break;
      case 'SpreadElement':
      case 'RestElement':
        add('spread', node);
        break;
      case 'ObjectPattern':
      case 'ArrayPattern':
        add('destructuring', node);
        break;
      case 'AssignmentPattern':
        add('default-parameter', node);
        break;
      case 'ForOfStatement':
        add('for-of', node);
        break;
      case 'AwaitExpression':
        add('async-await', node);
        break;
      case 'YieldExpression':
        add('generator', node);
        break;
      case 'ChainExpression':
        add('optional-chaining', node);
        break;
      case 'LogicalExpression':
        if (node.operator === '??') add('nullish-coalescing', node);
        break;
      case 'BinaryExpression':
        if (node.operator === '**') add('exponent-operator', node);
        break;
      case 'AssignmentExpression':
        if (node.operator === '**=') add('exponent-operator', node);
        break;
      case 'VariableDeclaration':
        if (node.kind === 'let' || node.kind === 'const') add('let-const', node);
        break;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
        if (node.async) add('async-await', node);
        if (node.generator) add('generator', node);
        break;
      default:
        break;
    }
  });

  return hits;
}

/** Every name a pattern binds, e.g. `var {a, b: [c]} = x`. */
function patternNames(node: any, out: Set<string>): void {
  if (!node) return;
  switch (node.type) {
    case 'Identifier':
      out.add(node.name);
      break;
    case 'ObjectPattern':
      for (const prop of node.properties) patternNames(prop.value ?? prop.argument, out);
      break;
    case 'ArrayPattern':
      for (const el of node.elements) patternNames(el, out);
      break;
    case 'AssignmentPattern':
      patternNames(node.left, out);
      break;
    case 'RestElement':
      patternNames(node.argument, out);
      break;
    default:
      break;
  }
}

/**
 * Names this script makes available to the rest of the report.
 *
 * BIRT scripts routinely set an implicit global in `initialize` and read it in
 * `beforeFactory`, so definitions are gathered across every block in the file
 * before any block is checked for unknown reads.
 */
function collectDefinitions(ast: acorn.Node, out: Set<string>): void {
  walk.full(ast, (node: any) => {
    switch (node.type) {
      case 'VariableDeclarator':
        patternNames(node.id, out);
        break;
      case 'ClassDeclaration':
        if (node.id) out.add(node.id.name);
        break;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        if (node.id) out.add(node.id.name);
        for (const p of node.params) patternNames(p, out);
        break;
      case 'CatchClause':
        patternNames(node.param, out);
        break;
      case 'AssignmentExpression':
        // `FOO = 1` with no declaration creates a global in non-strict code.
        if (node.left.type === 'Identifier') out.add(node.left.name);
        break;
      case 'ForInStatement':
      case 'ForOfStatement':
        if (node.left?.type === 'Identifier') out.add(node.left.name);
        break;
      case 'LabeledStatement':
        out.add(node.label.name);
        break;
      default:
        break;
    }
  });
}

/** Identifier reads, skipping positions where an identifier is just a name. */
function collectReads(ast: acorn.Node): Array<{ name: string; start: number; end: number }> {
  const reads: Array<{ name: string; start: number; end: number }> = [];
  walk.full(ast, (node: any, _state: unknown, _type: string) => {
    if (node.type !== 'Identifier') return;
    reads.push({ name: node.name, start: node.start, end: node.end });
  });

  // `walk.full` also reports `obj.prop`, `{ key: 1 }` and declaration ids, so
  // collect those positions and subtract them.
  const skip = new Set<number>();
  walk.full(ast, (node: any) => {
    switch (node.type) {
      case 'MemberExpression':
        if (!node.computed && node.property?.type === 'Identifier') skip.add(node.property.start);
        break;
      case 'Property':
        if (!node.computed && node.key?.type === 'Identifier') skip.add(node.key.start);
        break;
      case 'MethodDefinition':
      case 'PropertyDefinition':
        if (!node.computed && node.key?.type === 'Identifier') skip.add(node.key.start);
        break;
      case 'LabeledStatement':
        skip.add(node.label.start);
        break;
      case 'BreakStatement':
      case 'ContinueStatement':
        if (node.label) skip.add(node.label.start);
        break;
      default:
        break;
    }
  });

  return reads.filter((r) => !skip.has(r.start));
}

/** Lint every embedded script in one .rptdesign document. */
export function lintDocument(text: string, options: LintOptions = DEFAULT_OPTIONS): Problem[] {
  const blocks = findScriptBlocks(text);
  const problems: Problem[] = [];
  const parsed: Array<{ block: ScriptBlock; ast: acorn.Node }> = [];

  for (const block of blocks) {
    const ast = checkSyntax(block, options, problems);
    if (ast) parsed.push({ block, ast });
  }

  if (options.rhinoCompatibility && options.rhinoUnsupported.length > 0) {
    const wanted = new Set(options.rhinoUnsupported);
    for (const { block, ast } of parsed) {
      for (const hit of collectRhinoFeatures(ast)) {
        if (!wanted.has(hit.feature)) continue;
        problems.push({
          severity: 'warning',
          message: `${FEATURE_LABELS[hit.feature]} may not be supported by BIRT's Rhino script engine.`,
          start: toDoc(block, hit.start),
          end: toDoc(block, hit.end),
          code: `rhino/${hit.feature}`,
          block,
        });
      }
    }
  }

  if (options.undefinedGlobals) {
    const defined = new Set<string>([
      ...JS_GLOBALS,
      ...BIRT_GLOBALS,
      ...options.extraGlobals,
      ...(options.externalGlobals ?? []),
    ]);
    for (const { ast } of parsed) collectDefinitions(ast, defined);

    for (const { block, ast } of parsed) {
      const seen = new Set<string>();
      for (const read of collectReads(ast)) {
        if (defined.has(read.name) || seen.has(read.name)) continue;
        seen.add(read.name);
        problems.push({
          severity: 'warning',
          message: `"${read.name}" is not declared or assigned anywhere in this report, and is not a known BIRT or JavaScript global.`,
          start: toDoc(block, read.start),
          end: toDoc(block, read.end),
          code: 'undefined-global',
          block,
        });
      }
    }
  }

  problems.sort((a, b) => a.start - b.start);
  return problems;
}
