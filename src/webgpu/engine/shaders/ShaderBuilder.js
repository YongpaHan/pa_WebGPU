import { resolveIncludes } from "./Include";
import { globalUniformWgsl } from "../../shaders/global/globalUniform.wgsl";
import {
  msdfAtlasTextureName,
  msdfGlyphsStorageName,
} from "../../utils/msdfFont";

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAMPLE_TYPE_TO_COMPONENT = {
  float: "f32",
  sint: "i32",
  uint: "u32",
};
const ALLOWED_STORAGE_ACCESS = new Set(["read", "read_write"]);
const STORAGE_SPEC_KEYS = new Set([
  "name",
  "as",
  "type",
  "struct",
  "structName",
  "fields",
  "array",
  "access",
]);
const ALLOWED_VIEW_DIMENSIONS = new Set([
  "1d",
  "2d",
  "2d_array",
  "3d",
  "cube",
  "cube_array",
]);
const MSDF_GLYPHS_STRUCT_NAME = "MsdfGlyphs";

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function isIdentifier(value) {
  return typeof value === "string" && IDENTIFIER_RE.test(value);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeUniforms(uniforms) {
  if (!uniforms) return null;
  if (typeof uniforms !== "object" || Array.isArray(uniforms)) {
    throw new Error("buildShader: uniforms는 객체여야 합니다.");
  }

  const entries = Object.entries(uniforms);
  if (entries.length === 0) return null;

  const fields = entries.map(([name, type]) => {
    if (!isIdentifier(name)) {
      throw new Error(`buildShader: uniform 이름이 잘못되었습니다. (${name})`);
    }
    if (typeof type !== "string" || !type.trim()) {
      throw new Error(
        `buildShader: uniforms.${name} 타입 문자열이 필요합니다.`
      );
    }
    return { name, type: type.trim() };
  });

  return {
    structName: "LocalUniforms",
    varName: "local",
    fields,
  };
}

function normalizeTextureSpec(spec, index) {
  if (typeof spec === "string") {
    const name = spec.trim();
    if (!name) {
      throw new Error(`buildShader: textures[${index}] 이름이 비어 있습니다.`);
    }
    return {
      name,
      as: name,
      sampleType: "float",
      viewDimension: "2d",
      multisampled: false,
    };
  }

  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error(
      `buildShader: textures[${index}]는 문자열 또는 객체여야 합니다.`
    );
  }

  const name = String(spec.name ?? "").trim();
  if (!name) {
    throw new Error(`buildShader: textures[${index}].name이 필요합니다.`);
  }

  const as = String(spec.as ?? name).trim();
  if (!as) {
    throw new Error(`buildShader: textures[${index}].as가 잘못되었습니다.`);
  }

  const sampleType = spec.sampleType ?? "float";
  if (
    !Object.prototype.hasOwnProperty.call(SAMPLE_TYPE_TO_COMPONENT, sampleType)
  ) {
    throw new Error(
      `buildShader: textures[${index}].sampleType은 float/sint/uint 중 하나여야 합니다.`
    );
  }

  const viewDimension = spec.viewDimension ?? "2d";
  if (!ALLOWED_VIEW_DIMENSIONS.has(viewDimension)) {
    throw new Error(
      `buildShader: textures[${index}].viewDimension이 지원되지 않습니다.`
    );
  }

  return {
    name,
    as,
    sampleType,
    viewDimension,
    multisampled: Boolean(spec.multisampled),
  };
}

function normalizeTextures(textures) {
  return asArray(textures).map((spec, index) =>
    normalizeTextureSpec(spec, index)
  );
}

function sameTextureSpec(a, b) {
  return (
    a.name === b.name &&
    a.as === b.as &&
    a.sampleType === b.sampleType &&
    a.viewDimension === b.viewDimension &&
    a.multisampled === b.multisampled
  );
}

function mergeTextureSpecs(base, additions, ownerLabel) {
  const merged = [...base];

  for (const addition of additions) {
    const existing = merged.find(
      (entry) => entry.name === addition.name || entry.as === addition.as
    );
    if (!existing) {
      merged.push(addition);
      continue;
    }

    if (!sameTextureSpec(existing, addition)) {
      throw new Error(
        `buildShader: include '${ownerLabel}'가 예약한 texture '${addition.name}' 설정과 충돌합니다.`
      );
    }
  }

  return merged;
}

function normalizeStructFields(fields, path) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw new Error(`${path}는 객체여야 합니다.`);
  }

  const entries = Object.entries(fields);
  if (entries.length === 0) {
    throw new Error(`${path}는 최소 1개 이상의 필드를 가져야 합니다.`);
  }

  return entries.map(([name, type]) => {
    if (!isIdentifier(name)) {
      throw new Error(`${path} 필드 이름이 잘못되었습니다. (${name})`);
    }
    if (typeof type !== "string" || !type.trim()) {
      throw new Error(`${path}.${name} 타입 문자열이 필요합니다.`);
    }

    return {
      name,
      type: type.trim(),
    };
  });
}

function toPascalIdentifier(value, fallback = "Storage") {
  const parts = String(value ?? "")
    .match(/[A-Za-z0-9]+/g)
    ?.filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1)) ?? [];

  const joined = parts.join("") || fallback;
  return /^[A-Za-z_]/.test(joined) ? joined : `_${joined}`;
}

function isStorageSpecObject(value) {
  if (!isPlainObject(value)) return false;
  return Object.keys(value).some((key) => STORAGE_SPEC_KEYS.has(key));
}

function normalizeStorageSpec(spec, index, defaultName = null) {
  if (typeof spec === "string") {
    if (!defaultName) {
      throw new Error(
        `buildShader: storages[${index}] 문자열 선언은 객체형 storages에서만 사용할 수 있습니다.`
      );
    }

    spec = {
      type: spec,
    };
  }

  if (!isPlainObject(spec)) {
    throw new Error(`buildShader: storages[${index}]는 객체여야 합니다.`);
  }

  if (
    defaultName &&
    spec.name != null &&
    String(spec.name).trim() &&
    String(spec.name).trim() !== defaultName
  ) {
    throw new Error(
      `buildShader: storages.${defaultName}.name은 객체 키와 같아야 합니다.`
    );
  }

  const name = String(spec.name ?? defaultName ?? "").trim();
  if (!name) {
    throw new Error(`buildShader: storages[${index}].name이 필요합니다.`);
  }

  const as = String(spec.as ?? name).trim();
  if (!as || !isIdentifier(as)) {
    throw new Error(`buildShader: storages[${index}].as가 잘못되었습니다.`);
  }

  const explicitType = String(spec.type ?? "").trim();
  const structConfig = spec.struct ?? null;
  let structNameInput = spec.structName ?? null;
  let rawFields = spec.fields ?? null;
  let isArray = spec.array;

  if (structConfig != null) {
    if (typeof structConfig !== "object" || Array.isArray(structConfig)) {
      throw new Error(`buildShader: storages[${index}].struct는 객체여야 합니다.`);
    }

    const hasNestedConfig =
      Object.prototype.hasOwnProperty.call(structConfig, "fields") ||
      Object.prototype.hasOwnProperty.call(structConfig, "name") ||
      Object.prototype.hasOwnProperty.call(structConfig, "array");

    if (hasNestedConfig) {
      if (rawFields != null) {
        throw new Error(
          `buildShader: storages[${index}]는 fields와 struct.fields를 동시에 사용할 수 없습니다.`
        );
      }
      rawFields = structConfig.fields ?? null;
      if (structNameInput == null) {
        structNameInput = structConfig.name ?? null;
      }
      if (isArray == null && typeof structConfig.array === "boolean") {
        isArray = structConfig.array;
      }
    } else {
      if (rawFields != null) {
        throw new Error(
          `buildShader: storages[${index}]는 fields와 struct를 동시에 사용할 수 없습니다.`
        );
      }
      rawFields = structConfig;
    }
  }

  const access = String(spec.access ?? "read").trim();
  if (!ALLOWED_STORAGE_ACCESS.has(access)) {
    throw new Error(
      `buildShader: storages[${index}].access는 read/read_write 중 하나여야 합니다.`
    );
  }

  if (explicitType && rawFields) {
    throw new Error(
      `buildShader: storages[${index}]는 type 또는 struct/fields 중 하나만 사용할 수 있습니다.`
    );
  }

  let type = explicitType;
  let struct = null;

  if (rawFields) {
    const fields = normalizeStructFields(rawFields, `buildShader: storages[${index}].fields`);
    const finalIsArray = typeof isArray === "boolean" ? isArray : true;
    const structName = String(
      structNameInput ?? toPascalIdentifier(as, `Storage${index}`)
    ).trim();

    if (!isIdentifier(structName)) {
      throw new Error(
        `buildShader: storages[${index}].structName이 잘못되었습니다. (${structName})`
      );
    }

    struct = {
      name: structName,
      fields,
      isArray: finalIsArray,
    };
    type = finalIsArray ? `array<${structName}>` : structName;
  }

  if (!type) {
    throw new Error(
      `buildShader: storages[${index}].type 또는 struct/fields가 필요합니다.`
    );
  }

  return {
    name,
    as,
    type,
    access,
    bufferType: access === "read" ? "read-only-storage" : "storage",
    struct,
  };
}

function normalizeStorages(storages) {
  if (!storages) return [];
  if (Array.isArray(storages)) {
    return storages.map((spec, index) => normalizeStorageSpec(spec, index));
  }
  if (!isPlainObject(storages)) {
    throw new Error(
      "buildShader: storages는 배열 또는 이름 기반 객체여야 합니다."
    );
  }
  if (isStorageSpecObject(storages)) {
    return [normalizeStorageSpec(storages, 0)];
  }

  return Object.entries(storages).map(([name, spec], index) =>
    normalizeStorageSpec(spec, index, name)
  );
}

function sameStructSpec(a, b) {
  if (Boolean(a) !== Boolean(b)) return false;
  if (!a && !b) return true;
  if (a.name !== b.name || a.isArray !== b.isArray) return false;
  if (a.fields.length !== b.fields.length) return false;

  return a.fields.every(
    (field, index) =>
      field.name === b.fields[index]?.name && field.type === b.fields[index]?.type
  );
}

function sameStorageSpec(a, b) {
  return (
    a.name === b.name &&
    a.as === b.as &&
    a.type === b.type &&
    a.access === b.access &&
    a.bufferType === b.bufferType &&
    sameStructSpec(a.struct, b.struct)
  );
}

function mergeStorageSpecs(base, additions, ownerLabel) {
  const merged = [...base];

  for (const addition of additions) {
    const existing = merged.find(
      (entry) => entry.name === addition.name || entry.as === addition.as
    );
    if (!existing) {
      merged.push(addition);
      continue;
    }

    if (!sameStorageSpec(existing, addition)) {
      throw new Error(
        `buildShader: include '${ownerLabel}'가 예약한 storage '${addition.name}' 설정과 충돌합니다.`
      );
    }
  }

  return merged;
}

function applyIncludePresets(includeNames, textureSpecs, storageSpecs) {
  let nextTextures = textureSpecs;
  let nextStorages = storageSpecs;

  if (includeNames.includes("msdf")) {
    nextTextures = mergeTextureSpecs(
      nextTextures,
      [normalizeTextureSpec(msdfAtlasTextureName, nextTextures.length)],
      "msdf"
    );

    nextStorages = mergeStorageSpecs(
      nextStorages,
      [
        normalizeStorageSpec(
          {
            name: msdfGlyphsStorageName,
            as: msdfGlyphsStorageName,
            type: MSDF_GLYPHS_STRUCT_NAME,
          },
          nextStorages.length
        ),
      ],
      "msdf"
    );
  }

  return {
    textureSpecs: nextTextures,
    storageSpecs: nextStorages,
  };
}

function normalizeDefines(defines) {
  if (!defines) return [];
  if (typeof defines !== "object" || Array.isArray(defines)) {
    throw new Error("buildShader: defines는 객체여야 합니다.");
  }

  return Object.entries(defines).map(([name, value]) => {
    if (!isIdentifier(name)) {
      throw new Error(`buildShader: define 이름이 잘못되었습니다. (${name})`);
    }

    if (typeof value === "boolean") {
      return { name, expr: value ? "true" : "false" };
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new Error(`buildShader: defines.${name} 값이 유효하지 않습니다.`);
      }
      return { name, expr: String(value) };
    }
    if (typeof value === "string" && value.trim()) {
      return { name, expr: value.trim() };
    }

    throw new Error(
      `buildShader: defines.${name}는 boolean/number/string이어야 합니다.`
    );
  });
}

function buildGroup1Contract(localUniform, textures, storages) {
  const hasLocalUniform = Boolean(localUniform);
  const baseBinding = hasLocalUniform ? 1 : 0;

  const textureContracts = textures.map((texture, index) => {
    const textureBinding = baseBinding + index * 2;
    const samplerBinding = textureBinding + 1;
    return {
      ...texture,
      varName: texture.as,
      samplerName: `${texture.as}Sampler`,
      textureBinding,
      samplerBinding,
    };
  });

  const storageBaseBinding = baseBinding + textureContracts.length * 2;
  const storageContracts = storages.map((storage, index) => ({
    ...storage,
    varName: storage.as,
    binding: storageBaseBinding + index,
  }));

  return {
    uniform: hasLocalUniform
      ? {
          binding: 0,
          varName: localUniform.varName,
          structName: localUniform.structName,
          fields: localUniform.fields,
        }
      : null,
    textures: textureContracts,
    storages: storageContracts,
  };
}

function buildLocalUniformCode(localUniform, group1) {
  if (!group1.uniform || !localUniform) return "";

  const fields = localUniform.fields
    .map((field) => `  ${field.name}: ${field.type},`)
    .join("\n");

  return `
struct ${localUniform.structName} {
${fields}
};

@group(1) @binding(${group1.uniform.binding})
var<uniform> ${localUniform.varName}: ${localUniform.structName};
`.trim();
}

function buildTextureCode(group1) {
  if (group1.textures.length === 0) return "";

  return group1.textures
    .map((texture) => {
      const componentType = SAMPLE_TYPE_TO_COMPONENT[texture.sampleType];
      const textureType = `texture_${texture.viewDimension}<${componentType}>`;
      return `
@group(1) @binding(${texture.textureBinding})
var ${texture.varName}: ${textureType};

@group(1) @binding(${texture.samplerBinding})
var ${texture.samplerName}: sampler;
`.trim();
    })
    .join("\n\n");
}

function buildStorageCode(group1) {
  if (group1.storages.length === 0) return "";

  const structCode = group1.storages
    .filter((storage) => storage.struct)
    .map((storage) => {
      const fields = storage.struct.fields
        .map((field) => `  ${field.name}: ${field.type},`)
        .join("\n");

      return `
struct ${storage.struct.name} {
${fields}
};
`.trim();
    })
    .join("\n\n");

  const varCode = group1.storages
    .map(
      (storage) => `
@group(1) @binding(${storage.binding})
var<storage, ${storage.access}> ${storage.varName}: ${storage.type};
`.trim()
    )
    .join("\n\n");

  return [structCode, varCode].filter(Boolean).join("\n\n");
}

function buildDefinesCode(defines) {
  if (defines.length === 0) return "";
  return defines
    .map((entry) => `const ${entry.name} = ${entry.expr};`)
    .join("\n");
}

function buildIncludesCode(includes) {
  if (includes.length === 0) return "";
  const resolved = resolveIncludes(includes);
  return resolved
    .map((entry) => `// include:${entry.name}\n${entry.code}`)
    .join("\n\n");
}

function validateShader({ shader, localUniform, group1, defines, includes }) {
  if (typeof shader !== "string" || !shader.trim()) {
    throw new Error("buildShader: shader 문자열이 필요합니다.");
  }
  if (!/\bfn\s+vertexMain\s*\(/.test(shader)) {
    throw new Error("buildShader: shader에 vertexMain 함수가 필요합니다.");
  }
  if (!/\bfn\s+fragmentMain\s*\(/.test(shader)) {
    throw new Error("buildShader: shader에 fragmentMain 함수가 필요합니다.");
  }

  const usedNames = new Set(["global", "GlobalUniforms"]);
  if (localUniform) {
    usedNames.add(localUniform.structName);
    usedNames.add(localUniform.varName);
  }

  for (const texture of group1.textures) {
    if (!isIdentifier(texture.varName) || !isIdentifier(texture.samplerName)) {
      throw new Error(
        `buildShader: texture 이름이 유효하지 않습니다. (${texture.name})`
      );
    }
    if (usedNames.has(texture.varName) || usedNames.has(texture.samplerName)) {
      throw new Error(
        `buildShader: texture 이름 충돌이 있습니다. (${texture.varName})`
      );
    }
    usedNames.add(texture.varName);
    usedNames.add(texture.samplerName);
  }

  for (const storage of group1.storages) {
    if (!isIdentifier(storage.varName)) {
      throw new Error(
        `buildShader: storage 이름이 유효하지 않습니다. (${storage.name})`
      );
    }
    if (usedNames.has(storage.varName)) {
      throw new Error(
        `buildShader: storage 이름 충돌이 있습니다. (${storage.varName})`
      );
    }
    usedNames.add(storage.varName);

    if (storage.struct) {
      if (!isIdentifier(storage.struct.name)) {
        throw new Error(
          `buildShader: storage struct 이름이 유효하지 않습니다. (${storage.struct.name})`
        );
      }
      if (usedNames.has(storage.struct.name)) {
        throw new Error(
          `buildShader: storage struct 이름 충돌이 있습니다. (${storage.struct.name})`
        );
      }
      usedNames.add(storage.struct.name);
    }
  }

  for (const define of defines) {
    if (usedNames.has(define.name)) {
      throw new Error(
        `buildShader: define 이름 충돌이 있습니다. (${define.name})`
      );
    }
    usedNames.add(define.name);
  }

  for (const include of includes) {
    if (!isIdentifier(include)) {
      throw new Error(
        `buildShader: include 이름이 잘못되었습니다. (${include})`
      );
    }
  }
}

function composeCode(parts) {
  return parts
    .filter((part) => typeof part === "string" && part.trim())
    .map((part) => part.trim())
    .join("\n\n");
}

export function buildShader(config = {}) {
  const {
    includes = [],
    uniforms = null,
    textures = [],
    storages = [],
    defines = null,
    shader = "",
    validate = false,
  } = config;

  if (typeof shader !== "string" || !shader.trim()) {
    throw new Error("buildShader: shader 문자열이 필요합니다.");
  }

  const includeNames = asArray(includes);
  const localUniform = normalizeUniforms(uniforms);
  const normalizedTextures = normalizeTextures(textures);
  const normalizedStorages = normalizeStorages(storages);
  const { textureSpecs, storageSpecs } = applyIncludePresets(
    includeNames,
    normalizedTextures,
    normalizedStorages
  );
  const defineSpecs = normalizeDefines(defines);
  const group1 = buildGroup1Contract(localUniform, textureSpecs, storageSpecs);

  if (validate) {
    validateShader({
      shader,
      localUniform,
      group1,
      defines: defineSpecs,
      includes: includeNames,
    });
  }

  const code = composeCode([
    globalUniformWgsl,
    buildLocalUniformCode(localUniform, group1),
    buildTextureCode(group1),
    buildStorageCode(group1),
    buildDefinesCode(defineSpecs),
    buildIncludesCode(includeNames),
    shader,
  ]);

  return {
    code,
    contract: {
      group0: {
        uniform: {
          binding: 0,
          varName: "global",
          structName: "GlobalUniforms",
        },
      },
      group1,
      defines: defineSpecs,
    },
  };
}

export default buildShader;
