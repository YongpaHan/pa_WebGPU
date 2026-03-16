export const msdfAtlasTextureName = "fontAtlas";
export const msdfGlyphsStorageName = "glyphs";
export const msdfFontInfoStorageName = "fontInfo";
export const msdfGlyphTableStorageName = "glyphTable";

export const msdfFontInfoStruct = {
  atlasSize: "vec2f",
  distanceRange: "f32",
  glyphCount: "u32",
};

export const msdfGlyphStruct = {
  planeMin: "vec2f",
  planeMax: "vec2f",
  uvMin: "vec2f",
  uvMax: "vec2f",
  advance: "f32",
};

export const msdfGlyphsStruct = {
  atlasSize: "vec2f",
  distanceRange: "f32",
  glyphCount: "u32",
  glyphTable: "array<MsdfGlyph>",
};

function isExternalUrl(source) {
  return /^(?:[a-z]+:)?\/\//i.test(source);
}

function isRuntimeUrl(source) {
  return (
    source.startsWith("data:") ||
    source.startsWith("blob:") ||
    source.startsWith("file:")
  );
}

function resolveMsdfJsonUrl(source) {
  if (isExternalUrl(source) || isRuntimeUrl(source)) {
    return source;
  }

  const baseUrlRaw = String(import.meta.env.BASE_URL ?? "/");
  const baseUrl = baseUrlRaw.endsWith("/") ? baseUrlRaw : `${baseUrlRaw}/`;
  const normalizedBase = baseUrl
    .replace(/^\.?\//, "")
    .replace(/\/+$/, "");
  let normalizedSource = String(source).replace(/^\.?\//, "").replace(/^\/+/, "");

  if (normalizedBase && normalizedSource.startsWith(`${normalizedBase}/`)) {
    normalizedSource = normalizedSource.slice(normalizedBase.length + 1);
  }

  return `${baseUrl}${normalizedSource}`;
}

function buildFontUrlCandidates(path) {
  if (typeof path !== "string" || path.trim() === "") {
    throw new Error("loadMsdfFont(path): 폰트 경로 문자열이 필요합니다.");
  }

  const value = path.trim();
  if (value.endsWith(".json")) {
    return [
      {
        json: value,
        atlas: value.replace(/\.json$/i, ".png"),
      },
    ];
  }
  if (value.endsWith(".png")) {
    return [
      {
        json: value.replace(/\.png$/i, ".json"),
        atlas: value,
      },
    ];
  }

  const base = value.replace(/\/+$/, "");
  const parts = base.split("/").filter(Boolean);
  const stem = parts[parts.length - 1];
  if (!stem) {
    throw new Error(`loadMsdfFont(path): '${path}'에서 폰트 이름을 결정할 수 없습니다.`);
  }

  return [
    {
      json: `${base}.json`,
      atlas: `${base}.png`,
    },
    {
      json: `${base}/${stem}.json`,
      atlas: `${base}/${stem}.png`,
    },
  ];
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    return null;
  }

  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();

  if (contentType.includes("text/html")) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

async function resolveMsdfFont(path) {
  const candidates = buildFontUrlCandidates(path);
  for (const candidate of candidates) {
    const result = await fetchJson(resolveMsdfJsonUrl(candidate.json));
    if (!result) continue;
    return {
      atlas: candidate.atlas,
      meta: result,
    };
  }

  const tried = candidates.map((candidate) => candidate.json).join(", ");
  throw new Error(`loadMsdfFont('${path}'): JSON 요청 실패 (${tried})`);
}

function buildUvBounds(bounds, invAtlasWidth, invAtlasHeight, yOrigin) {
  if (!bounds || !invAtlasWidth || !invAtlasHeight) {
    return {
      uvMin: [0, 0],
      uvMax: [0, 0],
    };
  }

  const u0 = bounds.left * invAtlasWidth;
  const u1 = bounds.right * invAtlasWidth;

  if (yOrigin === "bottom") {
    return {
      uvMin: [u0, 1 - bounds.top * invAtlasHeight],
      uvMax: [u1, 1 - bounds.bottom * invAtlasHeight],
    };
  }

  return {
    uvMin: [u0, bounds.top * invAtlasHeight],
    uvMax: [u1, bounds.bottom * invAtlasHeight],
  };
}

function buildGlyphRecord(glyph, invAtlasWidth, invAtlasHeight, yOrigin) {
  const plane = glyph?.planeBounds ?? null;
  const { uvMin, uvMax } = buildUvBounds(
    glyph?.atlasBounds ?? null,
    invAtlasWidth,
    invAtlasHeight,
    yOrigin
  );

  const left = plane?.left ?? 0;
  const bottom = plane?.bottom ?? 0;
  const right = plane?.right ?? left;
  const top = plane?.top ?? bottom;

  return {
    planeMin: [left, bottom],
    planeMax: [right, top],
    uvMin,
    uvMax,
    advance: glyph?.advance ?? 0,
  };
}

function pickFallbackGlyphIndex(codepointToIndex) {
  for (const char of ["?", "□", " "]) {
    const codepoint = char.codePointAt(0);
    const index = codepointToIndex.get(codepoint);
    if (Number.isInteger(index)) {
      return index;
    }
  }
  return 0;
}

function firstSymbol(text) {
  if (typeof text !== "string" || text.length === 0) {
    return "";
  }

  const codepoint = text.codePointAt(0);
  return codepoint === undefined ? "" : String.fromCodePoint(codepoint);
}

export async function loadMsdfFont(path) {
  const resolved = await resolveMsdfFont(path);
  const meta = resolved.meta;

  if (!Array.isArray(meta?.glyphs)) {
    throw new Error(`loadMsdfFont('${path}'): glyphs 배열을 찾을 수 없습니다.`);
  }

  const atlasInfo = meta?.atlas ?? {};
  const atlasWidth = Number(atlasInfo?.width) || 1;
  const atlasHeight = Number(atlasInfo?.height) || 1;
  const invAtlasWidth = 1 / atlasWidth;
  const invAtlasHeight = 1 / atlasHeight;
  const yOrigin = atlasInfo?.yOrigin;
  const codepointToIndex = new Map();
  const data = meta.glyphs.map((glyph, index) => {
    if (Number.isInteger(glyph?.unicode)) {
      codepointToIndex.set(glyph.unicode, index);
    }
    return buildGlyphRecord(glyph, invAtlasWidth, invAtlasHeight, yOrigin);
  });

  const fallbackGlyphIndex =
    data.length > 0 ? pickFallbackGlyphIndex(codepointToIndex) : -1;
  const fontInfo = {
    atlasSize: [atlasWidth, atlasHeight],
    distanceRange: atlasInfo?.distanceRange ?? 4,
    glyphCount: data.length,
  };
  const glyphs = {
    atlasSize: fontInfo.atlasSize,
    distanceRange: fontInfo.distanceRange,
    glyphCount: fontInfo.glyphCount,
    glyphTable: data,
  };

  function resolveGlyphIndexFromSymbol(symbol) {
    const codepoint = symbol.codePointAt(0);
    const glyphIndex = codepointToIndex.get(codepoint);
    if (Number.isInteger(glyphIndex)) {
      return glyphIndex;
    }
    if (fallbackGlyphIndex >= 0) {
      return fallbackGlyphIndex;
    }

    throw new Error(`font.glyphs(text): '${symbol}'에 해당하는 glyph를 찾을 수 없습니다.`);
  }

  function resolveGlyphIndex(char) {
    const symbol = firstSymbol(char);
    if (!symbol) {
      throw new Error("font.glyphs(text): 최소 1개 이상의 문자가 필요합니다.");
    }

    return resolveGlyphIndexFromSymbol(symbol);
  }

  function assertGlyphText(text) {
    if (typeof text !== "string") {
      throw new Error("font.glyphs(text): 문자열이 필요합니다.");
    }
  }

  function buildGlyphIndexArray(text) {
    let glyphCount = 0;
    for (const _ of text) {
      glyphCount++;
    }

    const out = new Uint32Array(glyphCount);
    let outIndex = 0;
    for (const symbol of text) {
      out[outIndex++] = resolveGlyphIndexFromSymbol(symbol);
    }
    return out;
  }

  function resolveGlyphIndices(text) {
    assertGlyphText(text);
    return buildGlyphIndexArray(text);
  }

  return {
    atlas: resolved.atlas,
    data,
    glyphTable: data,
    fontInfo,
    glyphCount: data.length,
    metrics: meta.metrics ?? null,
    meta,
    glyphIndex(char) {
      return resolveGlyphIndex(char);
    },
    has(char) {
      const symbol = firstSymbol(char);
      if (!symbol) return false;
      return codepointToIndex.has(symbol.codePointAt(0));
    },
    glyphs(text) {
      assertGlyphText(text);

      const symbol = firstSymbol(text);
      if (!symbol) {
        return new Uint32Array(0);
      }
      if (symbol.length === text.length) {
        return resolveGlyphIndexFromSymbol(symbol);
      }

      return buildGlyphIndexArray(text);
    },
    glyphIndices(text) {
      return resolveGlyphIndices(text);
    },
    storage: {
      glyphs: {
        length: data.length,
        initialValues: glyphs,
      },
      // Backward-compatible split payload (fontInfo + glyphTable)
      fontInfo: {
        initialValues: fontInfo,
      },
      glyphTable: {
        length: data.length,
        initialValues: data,
      },
    },
  };
}

export async function bindMsdfFont({
  renderer,
  pass,
  font,
  atlasName = msdfAtlasTextureName,
  glyphsName = msdfGlyphsStorageName,
  // Legacy split bindings (optional): kept for compatibility.
  fontInfoName = msdfFontInfoStorageName,
  glyphTableName = msdfGlyphTableStorageName,
} = {}) {
  if (!renderer) {
    throw new Error("bindMsdfFont({ renderer, ... }): renderer가 필요합니다.");
  }
  if (!pass) {
    throw new Error("bindMsdfFont({ pass, ... }): pass가 필요합니다.");
  }
  if (!font) {
    throw new Error("bindMsdfFont({ font, ... }): font가 필요합니다.");
  }
  if (!renderer.device) {
    throw new Error("bindMsdfFont(...): renderer.init() 이후에 호출해야 합니다.");
  }

  await renderer.createTexture(atlasName, {
    source: font.atlas,
    flipY: false,
  });

  const glyphs = pass.createStorage(glyphsName, font.storage?.glyphs ?? {
    length: font.glyphTable?.length ?? font.data.length,
    initialValues: {
      atlasSize: font.fontInfo?.atlasSize ?? [1, 1],
      distanceRange: font.fontInfo?.distanceRange ?? 4,
      glyphCount: font.fontInfo?.glyphCount ?? (font.glyphTable?.length ?? font.data.length),
      glyphTable: font.glyphTable ?? font.data,
    },
  });

  return {
    atlasName,
    glyphsName,
    fontInfoName,
    glyphTableName,
    texture: renderer.getTexture(atlasName),
    glyphs,
  };
}
