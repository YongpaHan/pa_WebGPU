export const includeLibrary = {
  math: {
    code: /* wgsl */ `
        fn saturate(x: f32) -> f32 {
          return clamp(x, 0.0, 1.0);
        }
  
        fn remap(v: f32, inMin: f32, inMax: f32, outMin: f32, outMax: f32) -> f32 {
          let t = (v - inMin) / (inMax - inMin);
          return mix(outMin, outMax, t);
        }

        fn dot2(v: vec2f) -> f32 {
          return dot(v, v);
        }

        fn mod_f32(x: f32, y: f32) -> f32 {
          return x - y * floor(x / y);
        }
        fn mod_vec2(x: vec2<f32>, y: vec2<f32>) -> vec2<f32> {
          return x - y * floor(x / y);
        }
  
        fn rotate2d(p: vec2f, a: f32) -> vec2f {
          let c = cos(a);
          let s = sin(a);
          return vec2f(c * p.x + s * p.y, -s * p.x + c * p.y);
        }
      `,
  },
  color: {
    requires: ["math"],
    code: /* wgsl */ `
        fn linearstep(a: f32, b: f32, x: f32) -> f32 {
          return saturate((x - a) / (b - a));
        }
        fn luma(rgb: vec3f) -> f32 {
          return dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
        }
      `,
  },
  sdf: {
    requires: ["math"],
    code: /* wgsl */ `
        fn median(r: f32, g: f32, b: f32) -> f32 {
          return max(min(r, g), min(max(r, g), b));
        }

        fn smin(a: f32, b: f32, k: f32) -> f32 {
          let h = max(k - abs(a - b), 0.0) / k;
          return min(a, b) - h * h * k * 0.25;
        }
  
        fn sdCircle(p: vec2f, r: f32) -> f32 {
          return length(p) - r;
        }
        fn sdHeart(p_in: vec2<f32>) -> f32 {
          var p = p_in;
          p.y = p.y + 0.575;
          p.x = abs(p.x);
          if (p.y + p.x > 1.0) {
            return sqrt(dot2(p - vec2<f32>(0.25, 0.75))) - sqrt(2.0) / 4.0;
          }
          return sqrt(
            min(
                dot2(p - vec2<f32>(0.0, 1.0)),
                dot2(p - 0.5 * max(p.x + p.y, 0.0))
            )
          ) * sign(p.x - p.y);
        }
      `,
  },
  noise: {
    code: /* wgsl */ `
        fn hash21(p: vec2f) -> f32 {
          let h = dot(p, vec2f(127.1, 311.7));
          return fract(sin(h) * 43758.5453123);
        }
  
        fn noise21(p: vec2f) -> f32 {
          let i = floor(p);
          let f = fract(p);
          let a = hash21(i);
          let b = hash21(i + vec2f(1.0, 0.0));
          let c = hash21(i + vec2f(0.0, 1.0));
          let d = hash21(i + vec2f(1.0, 1.0));
          let u = f * f * (3.0 - 2.0 * f);
          return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
        }
      `,
  },
  gesture: {
    code: /* wgsl */ `
    const MAX_TOUCHES: i32 = 5;

    fn touch(i: i32) -> vec4f {
      return global.touches[i];
    }
    fn touchPos(i: i32) -> vec2f {
      return touch(i).xy;
    }
    fn touchActive(i: i32) -> bool {
      return touch(i).z > 0.5;
    }
    fn activeTouchCount() -> i32 {
      var count = 0;
      for (var i = 0; i < MAX_TOUCHES; i++) {
        if (touchActive(i)) {
          count += 1;
        }
      }
      return count;
    }
    fn gestureCenter(ratio: vec2f) -> vec2f {
      return global.gestureTransform.xy * ratio;
    }
    fn gestureZoom() -> f32 {
      return global.gestureTransform.z;
    }
    fn gestureAngle() -> f32 {
      return global.gestureTransform.w;
    }
  `,
  },
  msdf: {
    code: /* wgsl */ `
    struct MsdfGlyph {
      planeMin: vec2f,
      planeMax: vec2f,
      uvMin: vec2f,
      uvMax: vec2f,
      advance: f32,
    };

    struct MsdfGlyphs {
      atlasSize: vec2f,
      distanceRange: f32,
      glyphCount: u32,
      glyphTable: array<MsdfGlyph>,
    };

    fn msdfMedian3(v: vec3f) -> f32 {
      return max(min(v.x, v.y), min(max(v.x, v.y), v.z));
    }

    fn msdfScreenPxRange(atlasUv: vec2f) -> f32 {
      let unitRange =
        vec2f(glyphs.distanceRange) / max(glyphs.atlasSize, vec2f(1.0));
      let screenTexSize = vec2f(1.0) / max(fwidth(atlasUv), vec2f(1e-6));
      return max(0.5 * dot(unitRange, screenTexSize), 1.0);
    }

    fn msdfPlaneToAtlasUv(glyph: MsdfGlyph, p: vec2f) -> vec2f {
      let span = max(glyph.planeMax - glyph.planeMin, vec2f(1e-6));
      let t = clamp((p - glyph.planeMin) / span, vec2f(0.0), vec2f(1.0));
      // Glyph plane uses y-up coordinates, so atlas interpolation needs y flip.
      let atlasT = vec2f(t.x, 1.0 - t.y);
      return mix(glyph.uvMin, glyph.uvMax, atlasT);
    }

    fn drawMSDF(glyphIndex: u32, p: vec2f) -> f32 {
      let safeGlyphCount = max(glyphs.glyphCount, 1u);
      let glyph = glyphs.glyphTable[min(glyphIndex, safeGlyphCount - 1u)];
      let glyphSpan = max(glyph.planeMax - glyph.planeMin, vec2f(1e-6));
      let uvSpan = max(abs(glyph.uvMax - glyph.uvMin), vec2f(1e-6));
      let planePerUv = glyphSpan / uvSpan;
      let atlasUvPerPx = vec2f(1.0) / max(glyphs.atlasSize, vec2f(1.0));
      let planePad =
        planePerUv *
        atlasUvPerPx *
        vec2f(max(glyphs.distanceRange, 2));
      let glyphCenter = 0.5 * (glyph.planeMin + glyph.planeMax);
      let fitSpan = max(glyphSpan + planePad * 2.0, vec2f(1.0));
      // Isotropic fit keeps glyph aspect ratio stable across narrow/wide glyphs.
      let fitScale = max(fitSpan.x, fitSpan.y);
      let centeredP = p * fitScale + glyphCenter;
      let atlasUv = msdfPlaneToAtlasUv(glyph, centeredP);
      let msdf = textureSample(fontAtlas, fontAtlasSampler, atlasUv).rgb;
      let distanceField = msdfMedian3(msdf);

      let insideX =
        step(glyph.planeMin.x, centeredP.x) *
        step(centeredP.x, glyph.planeMax.x);
      let insideY =
        step(glyph.planeMin.y, centeredP.y) *
        step(centeredP.y, glyph.planeMax.y);
      let hasGlyphs = select(0.0, 1.0, glyphs.glyphCount > 0u);

      return distanceField * insideX * insideY * hasGlyphs;
    }
  `,
  },
};
