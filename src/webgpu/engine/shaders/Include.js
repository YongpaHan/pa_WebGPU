import { includeLibrary } from "../../shaders/global/function.wgsl";

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export function resolveInclude(name) {
  const spec = includeLibrary[name];
  if (!spec) throw new Error(`Unknown shader include: ${name}`);
  return spec.code;
}

function visitInclude(name, visited, visiting, resolved) {
  if (visited.has(name)) return;
  if (visiting.has(name)) {
    throw new Error(`Circular shader include dependency detected: ${name}`);
  }

  const spec = includeLibrary[name];
  if (!spec) throw new Error(`Unknown shader include: ${name}`);

  visiting.add(name);
  for (const dep of asArray(spec.requires)) {
    visitInclude(dep, visited, visiting, resolved);
  }
  visiting.delete(name);
  visited.add(name);

  resolved.push({ name, code: spec.code });
}

export function resolveIncludes(names = []) {
  const resolved = [];
  const visited = new Set();
  const visiting = new Set();

  for (const name of asArray(names)) {
    visitInclude(name, visited, visiting, resolved);
  }
  return resolved;
}

export const shaderIncludes = Object.fromEntries(
  Object.entries(includeLibrary).map(([name, spec]) => [name, spec.code])
);
