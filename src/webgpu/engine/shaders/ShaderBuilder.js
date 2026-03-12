import { resolveIncludes } from "./Include";
import { globalUniformWgsl } from "../../shaders/global/globalUniform.wgsl";

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAMPLE_TYPE_TO_COMPONENT = {
  float: "f32",
  sint: "i32",
  uint: "u32",
};
const ALLOWED_VIEW_DIMENSIONS = new Set([
  "1d",
  "2d",
  "2d_array",
  "3d",
  "cube",
  "cube_array",
]);

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function isIdentifier(value) {
  return typeof value === "string" && IDENTIFIER_RE.test(value);
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

function buildGroup1Contract(localUniform, textures) {
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
    defines = null,
    shader = "",
    validate = false,
  } = config;

  if (typeof shader !== "string" || !shader.trim()) {
    throw new Error("buildShader: shader 문자열이 필요합니다.");
  }

  const includeNames = asArray(includes);
  const localUniform = normalizeUniforms(uniforms);
  const textureSpecs = normalizeTextures(textures);
  const defineSpecs = normalizeDefines(defines);
  const group1 = buildGroup1Contract(localUniform, textureSpecs);

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
