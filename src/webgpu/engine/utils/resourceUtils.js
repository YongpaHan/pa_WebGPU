const resourceIdentityMap = new WeakMap();
let nextResourceIdentityId = 1;

export function getResourceIdentity(value) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return String(value);
  }
  if (!resourceIdentityMap.has(value)) {
    resourceIdentityMap.set(value, nextResourceIdentityId++);
  }
  return String(resourceIdentityMap.get(value));
}

export function isStorageBlockLike(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.getLayoutEntry === "function" &&
      typeof value.getBindResource === "function"
  );
}

export function isGpuBufferLike(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.destroy === "function" &&
      typeof value.size === "number"
  );
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isStorageBindingSpecLike(value) {
  if (!isPlainObject(value)) return false;

  return Boolean(
    value.block ||
      value.buffer ||
      value.resource ||
      Number.isInteger(value.binding) ||
      typeof value.upload === "function" ||
      value.bindingKey != null ||
      value.visibility != null ||
      value.bufferType != null
  );
}

export function normalizeResourceCollectionInput(resources) {
  if (resources == null) return {};
  if (Array.isArray(resources)) {
    return resources.reduce((acc, resource, slot) => {
      acc[`slot${slot}`] = resource;
      return acc;
    }, {});
  }
  if (isPlainObject(resources)) {
    return { ...resources };
  }
  return { slot0: resources };
}

export function normalizeStorageCollectionInput(storages) {
  if (storages == null) return [];
  if (Array.isArray(storages)) return storages;
  if (
    isStorageBlockLike(storages) ||
    isGpuBufferLike(storages) ||
    isStorageBindingSpecLike(storages)
  ) {
    return [storages];
  }
  if (isPlainObject(storages)) {
    return { ...storages };
  }
  return [storages];
}

export function normalizeResourceKey(nameOrSlot, label) {
  if (Number.isInteger(nameOrSlot) && nameOrSlot >= 0) {
    return `slot${nameOrSlot}`;
  }
  if (typeof nameOrSlot === "string" && nameOrSlot.trim()) {
    return nameOrSlot.trim();
  }
  throw new Error(`[${label}] resource key는 문자열 또는 0 이상의 정수여야 합니다.`);
}

export function resolveByContract(spec, slot, { localMap, renderer, label }) {
  const keys = [spec.name, spec.varName, `slot${slot}`];

  for (const key of keys) {
    if (!key) continue;
    const local = localMap[key];
    if (local != null) {
      if (typeof local === "string") {
        const fromRenderer = renderer?.getTexture?.(local);
        if (fromRenderer) return fromRenderer;
      } else {
        return local;
      }
    }
  }

  for (const key of [spec.name, spec.varName]) {
    if (!key) continue;
    const fromRenderer = renderer?.getTexture?.(key);
    if (fromRenderer) return fromRenderer;
  }

  throw new Error(
    `[${label}] 리소스 '${spec.name ?? spec.varName ?? slot}'를 찾을 수 없습니다.`
  );
}
