const GLOBAL_THIS = "globalThis";
const UNKNOWN = "__free2z_unknown__";
const CUSTOM = "__free2z_custom__";
const STRING_PREFIX = "__free2z_string__:";
const SET_INSTANCE_PREFIX = "Set:instance:";

const BUILT_INS = new Set([
  "Set",
  "RegExp",
  "Object",
  "Promise",
  "Array",
  "AbortSignal",
]);

const APIS = new Map([
  ["Set:instance:union", "Set.prototype.union"],
  ["Set:prototype:union", "Set.prototype.union"],
  ["RegExp:constructor:escape", "RegExp.escape"],
  ["Object:constructor:groupBy", "Object.groupBy"],
  ["Promise:constructor:withResolvers", "Promise.withResolvers"],
  ["Array:constructor:fromAsync", "Array.fromAsync"],
  ["AbortSignal:constructor:any", "AbortSignal.any"],
  ["AbortSignal:constructor:timeout", "AbortSignal.timeout"],
]);

const WRAPPERS = new Set([
  "ChainExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
]);

const CONTROL_TYPES = new Set([
  "IfStatement",
  "ConditionalExpression",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "SwitchCase",
  "LogicalExpression",
  "TryStatement",
  "CatchClause",
]);

function unwrap(node) {
  let current = node;
  while (current && WRAPPERS.has(current.type)) current = current.expression;
  return current;
}

function typeAnnotation(node) {
  let current = node;
  while (
    current &&
    ["TSTypeAnnotation", "TSParenthesizedType"].includes(current.type)
  ) {
    current = current.typeAnnotation;
  }
  return current;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Reject runtime APIs above the free2z browser floor when their built-in identity is statically proven.",
    },
    schema: [],
    messages: {
      runtimeFloor:
        "{{api}} is above the browser baseline; use a compatible alternative.",
    },
  },

  create(context) {
    const sourceCode = context.sourceCode;
    const typeAliases = new WeakMap();
    const mutations = [];
    const calls = [];
    const callsByFunction = new Map();
    const reported = new Set();

    function ancestors(node) {
      return sourceCode.getAncestors(node);
    }

    function isInside(node, parent) {
      return node === parent || ancestors(node).includes(parent);
    }

    function functionOwner(node) {
      return [...ancestors(node)]
        .reverse()
        .find((parent) =>
          [
            "FunctionDeclaration",
            "FunctionExpression",
            "ArrowFunctionExpression",
          ].includes(parent.type),
        );
    }

    function scopeVariable(identifier) {
      if (!identifier || identifier.type !== "Identifier") return null;
      let scope = sourceCode.getScope(identifier);
      while (scope) {
        const variable = scope.set?.get(identifier.name);
        if (variable) return variable;
        scope = scope.upper;
      }
      return null;
    }

    function isGlobalIdentifier(node, name) {
      const identifier = unwrap(node);
      if (identifier?.type !== "Identifier" || identifier.name !== name) {
        return false;
      }
      const variable = scopeVariable(identifier);
      return !variable || variable.defs.length === 0;
    }

    function joinValues(left, right) {
      return left === right ? left : UNKNOWN;
    }

    function isSetInstance(value) {
      return typeof value === "string" && value.startsWith(SET_INSTANCE_PREFIX);
    }

    function isApi(value) {
      return typeof value === "string" && value.startsWith("api:");
    }

    function apiName(value) {
      return isApi(value) ? value.slice(4) : null;
    }

    function normalisePropertyObject(value) {
      return isSetInstance(value) ? "Set:instance" : value;
    }

    function staticStringValue(value) {
      return typeof value === "string" && value.startsWith(STRING_PREFIX)
        ? value.slice(STRING_PREFIX.length)
        : null;
    }

    function controlBranch(control, node) {
      const branch = (candidate, name) =>
        candidate && isInside(node, candidate) ? name : null;

      switch (control.type) {
        case "IfStatement":
          return (
            branch(control.consequent, "then") ??
            branch(control.alternate, "else") ??
            (isInside(node, control.test) ? "test" : null)
          );
        case "ConditionalExpression":
          return (
            branch(control.consequent, "then") ??
            branch(control.alternate, "else") ??
            (isInside(node, control.test) ? "test" : null)
          );
        case "LogicalExpression":
          return branch(control.left, "left") ?? branch(control.right, "right");
        case "SwitchCase":
          return isInside(node, control.consequent) ? "case" : null;
        case "ForStatement":
        case "ForInStatement":
        case "ForOfStatement":
        case "WhileStatement":
        case "DoWhileStatement":
          return (
            branch(control.body, "body") ??
            (control.test && isInside(node, control.test) ? "test" : null)
          );
        case "TryStatement":
          return (
            branch(control.block, "try") ??
            branch(control.handler, "catch") ??
            branch(control.finalizer, "finally")
          );
        case "CatchClause":
          return branch(control.body, "catch");
        default:
          return null;
      }
    }

    function controlPath(node) {
      return ancestors(node)
        .filter((parent) => CONTROL_TYPES.has(parent.type))
        .map((control) => ({ control, branch: controlBranch(control, node) }))
        .filter(({ branch }) => branch);
    }

    // The returned status describes paths on which `write` can be observed at
    // `use`. A branch that may not run is an uncertainty, not a textual last
    // write. Sibling branches cannot reach one another.
    function sameOwnerRelation(write, use) {
      if (!write?.range || !use?.range || write.range[0] >= use.range[0]) {
        return null;
      }
      if (isInside(use, write)) return null;

      const usePath = new Map(
        controlPath(use).map(({ control, branch }) => [control, branch]),
      );
      let uncertain = false;
      for (const { control, branch } of controlPath(write)) {
        if (usePath.has(control)) {
          if (usePath.get(control) !== branch) return null;
        } else {
          uncertain = true;
        }
      }
      return uncertain ? "uncertain" : "definite";
    }

    function conditionalWithinOwner(node) {
      const owner = functionOwner(node);
      return controlPath(node).some(
        ({ control }) => functionOwner(control) === owner,
      );
    }

    function isFunctionAncestor(outer, inner) {
      return !!outer && !!inner && ancestors(inner).includes(outer);
    }

    function resolveStaticString(node, use = node, seen = new Set()) {
      const expression = unwrap(node);
      if (!expression) return null;
      if (expression.type === "Literal") {
        return typeof expression.value === "string" ? expression.value : null;
      }
      if (
        expression.type === "TemplateLiteral" &&
        expression.expressions.length === 0
      ) {
        return expression.quasis[0]?.value.cooked ?? null;
      }
      if (expression.type !== "Identifier") return null;
      const value = valueAt(expression, use, seen);
      return staticStringValue(value);
    }

    function propertyName(node, use = node) {
      const member = unwrap(node);
      if (!member || member.type !== "MemberExpression") return null;
      if (!member.computed && member.property.type === "Identifier") {
        return member.property.name;
      }
      if (member.computed && member.property.type === "Literal") {
        return typeof member.property.value === "string"
          ? member.property.value
          : null;
      }
      return member.computed ? resolveStaticString(member.property, use) : null;
    }

    // Return the path from an object/pattern source to a particular binding.
    // The key is resolved at the declaration/assignment site, not from the
    // last textual write to a key variable.
    function patternBinding(pattern, identifier, path = [], use = pattern) {
      if (!pattern) return null;
      if (pattern.type === "Identifier") {
        return pattern === identifier ? path : null;
      }
      if (pattern.type === "AssignmentPattern") {
        return patternBinding(pattern.left, identifier, path, use);
      }
      if (pattern.type === "RestElement") return null;
      if (pattern.type !== "ObjectPattern") return null;
      for (const property of pattern.properties) {
        if (property.type !== "Property") continue;
        const key = property.computed
          ? resolveStaticString(property.key, use)
          : property.key.type === "Identifier"
            ? property.key.name
            : property.key.value;
        if (typeof key !== "string") continue;
        const result = patternBinding(
          property.value,
          identifier,
          [...path, key],
          use,
        );
        if (result) return result;
      }
      return null;
    }

    function variableDefinition(variable) {
      for (const definition of variable?.defs ?? []) {
        if (definition.type !== "Variable" || !definition.node?.init) continue;
        const path = patternBinding(
          definition.node.id,
          definition.name,
          [],
          definition.node,
        );
        if (path) return { definition, path };
      }
      return null;
    }

    function assignmentBinding(reference) {
      const assignment = ancestors(reference.identifier)
        .reverse()
        .find((node) => node.type === "AssignmentExpression");
      if (!assignment || !assignment.left) return null;
      const path = patternBinding(
        assignment.left,
        reference.identifier,
        [],
        assignment,
      );
      return path ? { assignment, path } : null;
    }

    function typeIsSet(node, seen = new Set()) {
      const annotation = typeAnnotation(node);
      if (!annotation || annotation.type !== "TSTypeReference") return false;
      const name = annotation.typeName;
      if (name.type !== "Identifier") return false;
      if (name.name === "Set" && isGlobalIdentifier(name, "Set")) return true;
      const aliasVariable = scopeVariable(name);
      const alias = typeAliases.get(aliasVariable);
      if (!alias || seen.has(aliasVariable)) return false;
      seen.add(aliasVariable);
      return typeIsSet(alias, seen);
    }

    function resolveTypeAssertion(node) {
      let expression = node;
      while (expression?.type === "ParenthesizedExpression") {
        expression = expression.expression;
      }
      return expression &&
        ["TSAsExpression", "TSTypeAssertion"].includes(expression.type) &&
        typeIsSet(expression.typeAnnotation)
        ? `${SET_INSTANCE_PREFIX}assert:${expression.range[0]}:${expression.range[1]}`
        : null;
    }

    function applyBindingPath(value, path, use) {
      for (const property of path) {
        if (!value || value === UNKNOWN) return UNKNOWN;
        const object = normalisePropertyObject(value);
        if (object === GLOBAL_THIS && BUILT_INS.has(property)) {
          value = `${property}:constructor`;
          continue;
        }
        const currentProperty = propertyState(value, property, use);
        if (currentProperty !== UNKNOWN && currentProperty !== CUSTOM) {
          value = currentProperty;
          continue;
        }
        if (object === "Set:constructor" && property === "prototype") {
          value = "Set:prototype";
          continue;
        }
        return currentProperty;
      }
      return value;
    }

    function writeInfo(variable, reference) {
      const assignment = assignmentBinding(reference);
      if (assignment) {
        return {
          action: assignment.assignment,
          expression: assignment.assignment.right,
          path: assignment.path,
        };
      }
      const definition = variableDefinition(variable);
      if (definition && reference.identifier === definition.definition.name) {
        return {
          action: definition.definition.node,
          expression: definition.definition.node.init,
          path: definition.path,
        };
      }
      return {
        action: reference.identifier,
        expression: reference.writeExpr,
        path: [],
      };
    }

    function functionTargets(expression, seen = new Set()) {
      const node = unwrap(expression);
      if (!node) return [];
      if (
        [
          "FunctionDeclaration",
          "FunctionExpression",
          "ArrowFunctionExpression",
        ].includes(node.type)
      ) {
        return [{ fn: node, uncertain: false }];
      }
      if (node.type === "ConditionalExpression") {
        return [
          ...functionTargets(node.consequent, seen).map((target) => ({
            ...target,
            uncertain: true,
          })),
          ...functionTargets(node.alternate, seen).map((target) => ({
            ...target,
            uncertain: true,
          })),
        ];
      }
      if (node.type !== "Identifier") return [];
      const variable = scopeVariable(node);
      if (!variable || seen.has(variable)) return [];
      seen.add(variable);
      const targets = [];
      for (const definition of variable.defs ?? []) {
        if (
          definition.type === "FunctionName" &&
          definition.node?.type === "FunctionDeclaration"
        ) {
          targets.push({ fn: definition.node, uncertain: false });
        }
      }
      const definition = variableDefinition(variable);
      if (definition && definition.path.length === 0) {
        targets.push(...functionTargets(definition.definition.node.init, seen));
      }
      for (const reference of variable.references ?? []) {
        if (
          !reference.isWrite() ||
          reference.identifier.range[0] > node.range[0]
        ) {
          continue;
        }
        const info = writeInfo(variable, reference);
        if (info.path.length === 0) {
          targets.push(...functionTargets(info.expression, seen));
        }
      }
      const unique = new Map();
      for (const target of targets) {
        const existing = unique.get(target.fn);
        unique.set(target.fn, {
          fn: target.fn,
          uncertain: !!existing?.uncertain || target.uncertain,
        });
      }
      return [...unique.values()];
    }

    function callTargets(call) {
      const targets = functionTargets(call.callee);
      return targets.length > 1
        ? targets.map((target) => ({ ...target, uncertain: true }))
        : targets;
    }

    function callCanReach(call, use, seen = new Set()) {
      if (!call?.range || !use?.range || call.range[0] >= use.range[0]) {
        return null;
      }
      const owner = functionOwner(call);
      const useOwner = functionOwner(use);
      if (owner === useOwner) return sameOwnerRelation(call, use);
      if (!owner && !useOwner) return sameOwnerRelation(call, use);
      if (!owner) return null;
      if (isFunctionAncestor(owner, useOwner)) return "uncertain";
      const key = `${owner.range?.[0]}:${use.range?.[0]}`;
      if (seen.has(key)) return null;
      seen.add(key);
      const status = functionActivationStatus(owner, use, seen);
      if (!status) return null;
      return conditionalWithinOwner(call) ? "uncertain" : status;
    }

    function functionActivationStatus(fn, use, seen = new Set()) {
      const useOwner = functionOwner(use);
      if (fn === useOwner || isFunctionAncestor(fn, useOwner))
        return "definite";
      let result = null;
      for (const entry of callsByFunction.get(fn) ?? []) {
        let status = callCanReach(entry.call, use, seen);
        if (!status) continue;
        if (entry.uncertain) status = "uncertain";
        result =
          result === "uncertain" || status === "uncertain"
            ? "uncertain"
            : "definite";
      }
      return result;
    }

    function actionEvents(action, use) {
      const owner = functionOwner(action);
      const useOwner = functionOwner(use);
      if (owner === useOwner) {
        const status = sameOwnerRelation(action, use);
        return status ? [{ status, order: action.range[0] }] : [];
      }
      if (!owner && !useOwner) {
        const status = sameOwnerRelation(action, use);
        return status ? [{ status, order: action.range[0] }] : [];
      }

      // A write in an enclosing function is observed only when it occurs
      // before the call that enters the nested function containing `use`.
      if (useOwner && (!owner || isFunctionAncestor(owner, useOwner))) {
        const entries = (callsByFunction.get(useOwner) ?? []).filter(
          (entry) => functionOwner(entry.call) === owner,
        );
        const events = [];
        for (const entry of entries) {
          let status = sameOwnerRelation(action, entry.call);
          if (!status) continue;
          if (entry.uncertain || conditionalWithinOwner(action)) {
            status = "uncertain";
          }
          events.push({
            status,
            order: entry.call.range[0] + action.range[0] / 1e12,
          });
        }
        if (events.length) return events;
      }

      if (!owner) return [];
      const events = [];
      for (const entry of callsByFunction.get(owner) ?? []) {
        let status = callCanReach(entry.call, use);
        if (!status) continue;
        if (entry.uncertain || conditionalWithinOwner(action)) {
          status = "uncertain";
        }
        events.push({
          status,
          order: entry.call.range[0] + action.range[0] / 1e12,
        });
      }
      return events;
    }

    function variableWrites(variable) {
      const writes = [];
      const seen = new Set();
      for (const reference of variable?.references ?? []) {
        if (!reference.isWrite()) continue;
        const info = writeInfo(variable, reference);
        const key = info.action?.range?.join(":");
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        writes.push(info);
      }
      for (const definition of variable?.defs ?? []) {
        if (definition.type !== "Variable" || !definition.node?.init) continue;
        const key = definition.node.range?.join(":");
        if (key && seen.has(key)) continue;
        const path = patternBinding(
          definition.node.id,
          definition.name,
          [],
          definition.node,
        );
        if (path) {
          writes.push({
            action: definition.node,
            expression: definition.node.init,
            path,
          });
        }
      }
      return writes;
    }

    function variableValue(variable, use, seen = new Set()) {
      if (!variable || seen.has(variable)) return UNKNOWN;
      const nextSeen = new Set(seen).add(variable);
      let state = typeIsSet(variable.identifiers?.[0]?.typeAnnotation)
        ? `${SET_INSTANCE_PREFIX}typed:${variable.identifiers[0].range?.[0] ?? "parameter"}`
        : UNKNOWN;
      const events = [];
      for (const write of variableWrites(variable)) {
        for (const event of actionEvents(write.action, use)) {
          events.push({ ...event, write });
        }
      }
      events.sort((left, right) => left.order - right.order);
      for (const event of events) {
        const raw = event.write.expression
          ? valueAt(event.write.expression, event.write.action, nextSeen)
          : UNKNOWN;
        const value = applyBindingPath(
          raw,
          event.write.path,
          event.write.action,
        );
        state = event.status === "uncertain" ? joinValues(state, value) : value;
      }
      return state;
    }

    function mutationTarget(mutation) {
      const name = propertyName(mutation.left, mutation.action);
      if (!name) return { object: UNKNOWN, name: null };
      return {
        object: valueAt(mutation.left.object, mutation.action),
        name,
      };
    }

    function mutationCouldAffect(mutation, object, name) {
      const targetName = propertyName(mutation.left, mutation.action);
      if (targetName !== null && targetName !== name) return false;
      const target = mutationTarget(mutation);
      return target.object === UNKNOWN || target.object === object;
    }

    function defaultPropertyValue(object, name) {
      const normalised = normalisePropertyObject(object);
      const api = APIS.get(`${normalised}:${name}`);
      return api ? `api:${api}` : CUSTOM;
    }

    function mutationState(object, name, use) {
      let state = defaultPropertyValue(object, name);
      const events = [];
      for (const mutation of mutations) {
        if (!mutationCouldAffect(mutation, object, name)) continue;
        for (const event of actionEvents(mutation.action, use)) {
          events.push({ ...event, mutation });
        }
      }
      events.sort((left, right) => left.order - right.order);
      for (const event of events) {
        const value = valueAt(event.mutation.right, event.mutation.action);
        state = event.status === "uncertain" ? joinValues(state, value) : value;
      }
      return state;
    }

    function hasMutation(object, name, use) {
      return mutations.some(
        (mutation) =>
          mutationCouldAffect(mutation, object, name) &&
          actionEvents(mutation.action, use).length > 0,
      );
    }

    function propertyState(object, name, use, seen = new Set()) {
      if (!object || object === UNKNOWN) return UNKNOWN;
      const key = `${object}:${name}:${use.range?.[0]}`;
      if (seen.has(key)) return UNKNOWN;
      const nextSeen = new Set(seen).add(key);
      const own = mutationState(object, name, use);
      if (!isSetInstance(object) || hasMutation(object, name, use)) return own;
      const prototype = mutationState("Set:prototype", name, use);
      return hasMutation("Set:prototype", name, use) ? prototype : own;
    }

    function memberValue(member, use, seen = new Set()) {
      const name = propertyName(member, use);
      const object = valueAt(member.object, use, seen);
      if (!name || !object || object === UNKNOWN) return UNKNOWN;
      if (object === GLOBAL_THIS && BUILT_INS.has(name)) {
        return `${name}:constructor`;
      }
      if (object === "Set:constructor" && name === "prototype") {
        return "Set:prototype";
      }
      if (isSetInstance(object) && name === "constructor") {
        return "Set:constructor";
      }
      const state = propertyState(object, name, use, seen);
      if (state !== CUSTOM && state !== UNKNOWN) return state;
      return state;
    }

    function valueAt(node, use = node, seen = new Set()) {
      const asserted = resolveTypeAssertion(node);
      if (asserted) return asserted;
      const expression = unwrap(node);
      if (!expression) return UNKNOWN;

      if (expression.type === "Identifier") {
        if (isGlobalIdentifier(expression, GLOBAL_THIS)) return GLOBAL_THIS;
        if (
          BUILT_INS.has(expression.name) &&
          isGlobalIdentifier(expression, expression.name)
        ) {
          return `${expression.name}:constructor`;
        }
        return variableValue(scopeVariable(expression), use, seen);
      }
      if (expression.type === "Literal") {
        return typeof expression.value === "string"
          ? `${STRING_PREFIX}${expression.value}`
          : CUSTOM;
      }
      if (
        expression.type === "TemplateLiteral" &&
        expression.expressions.length === 0
      ) {
        return `${STRING_PREFIX}${expression.quasis[0]?.value.cooked ?? ""}`;
      }
      if (expression.type === "NewExpression") {
        return valueAt(expression.callee, use, seen) === "Set:constructor"
          ? `${SET_INSTANCE_PREFIX}new:${expression.range[0]}:${expression.range[1]}`
          : CUSTOM;
      }
      if (expression.type === "MemberExpression") {
        return memberValue(expression, use, seen);
      }
      if (expression.type === "AssignmentExpression") {
        return valueAt(expression.right, use, seen);
      }
      if (expression.type === "ConditionalExpression") {
        return joinValues(
          valueAt(expression.consequent, use, seen),
          valueAt(expression.alternate, use, seen),
        );
      }
      if (
        [
          "FunctionExpression",
          "ArrowFunctionExpression",
          "ClassExpression",
          "ObjectExpression",
          "ArrayExpression",
        ].includes(expression.type)
      ) {
        return CUSTOM;
      }
      return UNKNOWN;
    }

    function directMemberOrigin(node, use, seen = new Set()) {
      const expression = unwrap(node);
      if (!expression) return false;
      if (expression.type === "MemberExpression") {
        return isApi(valueAt(expression, use));
      }
      if (expression.type !== "Identifier") return false;
      const variable = scopeVariable(expression);
      if (!variable || seen.has(variable)) return false;
      const nextSeen = new Set(seen).add(variable);
      const events = [];
      for (const write of variableWrites(variable)) {
        for (const event of actionEvents(write.action, use)) {
          events.push({ ...event, write });
        }
      }
      events.sort((left, right) => left.order - right.order);
      if (
        !events.length ||
        events.some((event) => event.status === "uncertain")
      ) {
        return false;
      }
      const last = events.at(-1).write;
      if (last.path.length > 0) return false;
      return directMemberOrigin(last.expression, last.action, nextSeen);
    }

    // `obj.prop = AbortSignal.any` STORES the API; the mutation index above
    // tracks the property and reports at whatever site eventually calls it,
    // so reporting the reference here too would double-report. But
    // `obj.prop = AbortSignal.any([])` INVOKES it: what lands on the property
    // is the return value, so the deferred call-site tracking never sees the
    // API and nothing is ever reported. An invocation is an execution, not a
    // stash -- report it here or it escapes the gate entirely.
    function isInvoked(node) {
      let current = node;
      let parent = current.parent;
      while (parent && WRAPPERS.has(parent.type)) {
        current = parent;
        parent = current.parent;
      }
      return parent?.type === "CallExpression" && parent.callee === current;
    }

    function isPropertyAssignmentRhs(node) {
      if (isInvoked(node)) return false;
      return ancestors(node).some(
        (parent) =>
          parent.type === "AssignmentExpression" &&
          isInside(node, parent.right) &&
          unwrap(parent.left)?.type === "MemberExpression",
      );
    }

    function reportApi(node, api) {
      const key = `${node.range[0]}:${node.range[1]}:${api}`;
      if (reported.has(key)) return;
      reported.add(key);
      context.report({
        node,
        messageId: "runtimeFloor",
        data: { api },
      });
    }

    function walk(node, visit) {
      if (!node || typeof node !== "object" || typeof node.type !== "string") {
        return;
      }
      visit(node);
      for (const key of sourceCode.visitorKeys[node.type] ?? []) {
        const child = node[key];
        if (Array.isArray(child)) {
          for (const item of child) walk(item, visit);
        } else {
          walk(child, visit);
        }
      }
    }

    // Index declarations before any rule visitor runs. This is what makes a
    // forward type alias as reliable as an earlier one while preserving scope
    // identity for same-named nested aliases.
    walk(sourceCode.ast, (node) => {
      if (node.type === "TSTypeAliasDeclaration") {
        const variable = scopeVariable(node.id);
        if (variable) typeAliases.set(variable, node.typeAnnotation);
      }
      if (node.type === "CallExpression") calls.push(node);
      if (
        node.type === "AssignmentExpression" &&
        unwrap(node.left)?.type === "MemberExpression"
      ) {
        const left = unwrap(node.left);
        mutations.push({
          action: node,
          left,
          right: node.right,
        });
      }
    });

    for (const call of calls) {
      for (const target of callTargets(call)) {
        const entries = callsByFunction.get(target.fn) ?? [];
        entries.push({ call, uncertain: target.uncertain });
        callsByFunction.set(target.fn, entries);
      }
    }

    return {
      MemberExpression(node) {
        if (isPropertyAssignmentRhs(node)) return;
        if (
          node.parent?.type === "AssignmentExpression" &&
          node.parent.left === node
        ) {
          return;
        }
        if (
          node.parent?.type === "MemberExpression" &&
          node.parent.object === node
        ) {
          return;
        }

        const value = valueAt(node, node);
        if (isApi(value)) {
          reportApi(node.property, apiName(value));
          return;
        }

        const object = valueAt(node.object, node);
        const sourceObject = unwrap(node.object);
        if (
          isApi(object) &&
          (sourceObject?.type !== "Identifier" ||
            !directMemberOrigin(node.object, node))
        ) {
          reportApi(node.object, apiName(object));
        }
      },
      CallExpression(node) {
        if (node.callee.type !== "Identifier") return;
        const value = valueAt(node.callee, node);
        if (!isApi(value)) return;
        if (directMemberOrigin(node.callee, node)) return;
        reportApi(node.callee, apiName(value));
      },
    };
  },
};
