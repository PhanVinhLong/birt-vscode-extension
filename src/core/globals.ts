/** Identifiers the undefined-globals check treats as always available. */

export const JS_GLOBALS: readonly string[] = [
  'Array', 'ArrayBuffer', 'Boolean', 'DataView', 'Date', 'Error', 'EvalError',
  'Function', 'Infinity', 'Intl', 'JSON', 'Map', 'Math', 'NaN', 'Number',
  'Object', 'Promise', 'Proxy', 'RangeError', 'ReferenceError', 'Reflect',
  'RegExp', 'Set', 'String', 'Symbol', 'SyntaxError', 'TypeError', 'URIError',
  'WeakMap', 'WeakSet', 'decodeURI', 'decodeURIComponent', 'encodeURI',
  'encodeURIComponent', 'escape', 'eval', 'globalThis', 'isFinite', 'isNaN',
  'parseFloat', 'parseInt', 'undefined', 'unescape', 'arguments', 'console',
];

/**
 * Objects BIRT injects into the script scope, plus the Rhino bridge into Java.
 * See the BIRT "Report Object Model" and scripting API documentation.
 */
export const BIRT_GLOBALS: readonly string[] = [
  // Report script context
  'reportContext', 'params', 'vars', 'config', 'design', 'report', 'this',
  // Element / row scope
  'reportElement', 'row', 'dataSetRow', 'data', 'self', 'measure', 'dimension',
  '__rownum', 'currentPage', 'pageNumber', 'totalPage',
  // Aggregation and helper libraries
  'Total', 'BirtDateTime', 'BirtStr', 'BirtMath', 'BirtComp', 'BirtDuration',
  'Formatter', 'JavascriptException',
  // Rhino's Java bridge
  'Packages', 'java', 'javax', 'org', 'com', 'importPackage', 'importClass',
  'JavaAdapter', 'getClass', 'loadClass', 'sync', 'spawn', 'runCommand',
];
