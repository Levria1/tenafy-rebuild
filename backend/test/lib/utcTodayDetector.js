const acorn = require('acorn');

function findUtcTodayDerivations(source, filename) {
  let ast;
  try {
    ast = parse(source, 'script');
  } catch (scriptError) {
    try {
      ast = parse(source, 'module');
    } catch (moduleError) {
      const err = moduleError || scriptError;
      const loc = err.loc || { line: 1, column: 0 };
      return [{
        file: filename,
        line: loc.line,
        column: loc.column,
        snippet: snippet(source, loc.line),
        kind: 'parse-error',
        why: `Could not parse JavaScript: ${err.message}`,
      }];
    }
  }

  const findings = [];
  analyzeScope(ast, source, filename, findings);
  return findings;
}

function parse(source, sourceType) {
  return acorn.parse(source, { ecmaVersion: 'latest', sourceType, locations: true, allowHashBang: true });
}

function analyzeScope(root, source, filename, findings, inherited = new Set(), shadowed = []) {
  // Nested scopes INHERIT what the enclosing one knows, because capturing the date
  // in a closure is an ordinary thing to write:
  //     const now = new Date();
  //     items.map(x => now.toISOString().split('T')[0]);   // still the bug
  // Isolating each function would miss every one of those.
  //
  // The names a nested function re-binds are dropped on entry, so a parameter that
  // merely reuses the name does not inherit the taint. Local declarations are
  // handled in VariableDeclarator below, which now also CLEARS taint when a name is
  // re-declared from something that is not "now".
  const tainted = new Set(inherited);
  for (const name of shadowed) tainted.delete(name);

  // The bug is deriving a Hong Kong business date from the current UTC clock.
  // Only "now" expressions are seeded; stored dates are specific record values,
  // so cursor/lease/row dates and new Date(storedValue) are intentionally clean.
  function isTainted(node) {
    if (!node) return false;
    if (node.type === 'Identifier') return tainted.has(node.name);
    if (isNowSeed(node)) return true;
    if (node.type === 'NewExpression' && id(node.callee, 'Date')) {
      return node.arguments.some(isTainted);
    }
    if (node.type === 'AssignmentExpression' && node.operator === '=') return isTainted(node.right);
    if (node.type === 'ConditionalExpression') return isTainted(node.consequent) || isTainted(node.alternate);
    if (node.type === 'LogicalExpression' && (node.operator === '||' || node.operator === '??')) {
      return isTainted(node.left) || isTainted(node.right);
    }
    if (node.type === 'ChainExpression' || node.type === 'ParenthesizedExpression') return isTainted(node.expression);
    return false;
  }

  function visit(node) {
    if (!node) return;
    if (isFn(node)) {
      analyzeScope(node.body, source, filename, findings, tainted, paramNames(node));
      return;
    }

    if (isUtcIsoDateSink(node, isTainted)) {
      addFinding(node, filename, source, findings, 'UTC clock value is formatted as YYYY-MM-DD; use orgToday() from src/utils/orgTime.js.');
    } else if (isHandBuiltUtcDate(node, isTainted)) {
      addFinding(node, filename, source, findings, 'UTC calendar parts are assembled from the current clock; use orgToday() from src/utils/orgTime.js.');
    }

    if (node.type === 'VariableDeclarator') {
      if (node.id.type === 'Identifier') {
        // Clearing matters as much as setting: `const d = row.due_on` inside a scope
        // that inherited a tainted `d` must NOT keep treating it as "now".
        if (isTainted(node.init)) tainted.add(node.id.name);
        else tainted.delete(node.id.name);
      }
      visit(node.init);
      return;
    }
    if (node.type === 'AssignmentExpression') {
      visit(node.right);
      if (node.operator === '=' && node.left.type === 'Identifier') {
        if (isTainted(node.right)) tainted.add(node.left.name);
        else tainted.delete(node.left.name);
      } else {
        visit(node.left);
      }
      return;
    }
    for (const child of children(node)) visit(child);
  }

  visit(root);
}

function isNowSeed(node) {
  if (dateNow(node)) return true;
  if (!node || node.type !== 'NewExpression' || !id(node.callee, 'Date')) return false;
  if (node.arguments.length === 0) return true;
  if (node.arguments.length !== 1) return false;
  const arg = node.arguments[0];
  return dateNow(arg) || id(arg, 'undefined') || (arg.type === 'UnaryExpression' && arg.operator === 'void');
}

function isUtcIsoDateSink(node, isTainted) {
  if (node.type === 'CallExpression' && member(node.callee, ['slice', 'substring', 'substr'])) {
    return zeroTen(node) && utcStringFromTainted(node.callee.object, isTainted);
  }
  if (node.type === 'MemberExpression' && node.computed && (lit(node.property, 0) || lit(node.property, '0'))) {
    return splitTOfUtcString(node.object, isTainted);
  }
  if (node.type === 'CallExpression' && member(node.callee, 'at')) {
    return node.arguments.length === 1 && lit(node.arguments[0], 0) && splitTOfUtcString(node.callee.object, isTainted);
  }
  return false;
}

function utcStringFromTainted(node, isTainted) {
  return node &&
    node.type === 'CallExpression' &&
    member(node.callee, ['toISOString', 'toJSON']) &&
    isTainted(node.callee.object);
}

function splitTOfUtcString(node, isTainted) {
  return node &&
    node.type === 'CallExpression' &&
    member(node.callee, 'split') &&
    node.arguments.length >= 1 &&
    lit(node.arguments[0], 'T') &&
    utcStringFromTainted(node.callee.object, isTainted);
}

function isHandBuiltUtcDate(node, isTainted) {
  if (node.type !== 'TemplateLiteral' && !(node.type === 'BinaryExpression' && node.operator === '+')) return false;
  const seen = { getUTCFullYear: false, getUTCMonth: false, getUTCDate: false };
  collectUtcParts(node, isTainted, seen);
  return seen.getUTCFullYear && seen.getUTCMonth && seen.getUTCDate;
}

function collectUtcParts(node, isTainted, seen) {
  if (!node) return;
  if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
    const name = prop(node.callee);
    if (Object.prototype.hasOwnProperty.call(seen, name) && isTainted(node.callee.object)) seen[name] = true;
  }
  for (const child of children(node)) collectUtcParts(child, isTainted, seen);
}

function addFinding(node, filename, source, findings, why) {
  findings.push({ file: filename, line: node.loc.start.line, column: node.loc.start.column, snippet: snippet(source, node.loc.start.line), why });
}

function children(node) {
  const out = [];
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item.type === 'string') out.push(item);
    } else if (value && typeof value.type === 'string') {
      out.push(value);
    }
  }
  return out;
}

function dateNow(node) {
  return node && node.type === 'CallExpression' && member(node.callee, 'now') && id(node.callee.object, 'Date');
}

function member(node, names) {
  if (!node || node.type !== 'MemberExpression') return false;
  const name = prop(node);
  return Array.isArray(names) ? names.includes(name) : name === names;
}

function prop(node) {
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  if (node.computed && node.property.type === 'Literal') return String(node.property.value);
  return null;
}

function zeroTen(node) {
  return node.arguments.length >= 2 && lit(node.arguments[0], 0) && lit(node.arguments[1], 10);
}

function isFn(node) {
  return ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type);
}

// Every name a function binds through its parameter list, including destructured
// and defaulted ones. These shadow the enclosing scope, so inherited taint on the
// same name must be dropped or a plain parameter would be reported as "now".
function paramNames(fn) {
  const names = [];
  const walkPattern = (p) => {
    if (!p) return;
    switch (p.type) {
      case 'Identifier': names.push(p.name); break;
      case 'AssignmentPattern': walkPattern(p.left); break;
      case 'RestElement': walkPattern(p.argument); break;
      case 'ArrayPattern': p.elements.forEach(walkPattern); break;
      case 'ObjectPattern':
        for (const prop of p.properties) {
          walkPattern(prop.type === 'RestElement' ? prop.argument : prop.value);
        }
        break;
      default: break;
    }
  };
  (fn.params || []).forEach(walkPattern);
  return names;
}

function id(node, name) {
  return node && node.type === 'Identifier' && node.name === name;
}

function lit(node, value) {
  return node && node.type === 'Literal' && node.value === value;
}

function snippet(source, line) { return (source.split(/\r?\n/)[line - 1] || '').trim(); }

module.exports = { findUtcTodayDerivations };
