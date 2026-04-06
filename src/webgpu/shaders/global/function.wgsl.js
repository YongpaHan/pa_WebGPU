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

        // 기본 스칼라
        fn random(st: vec2f) -> f32 {
          return fract(sin(dot(st.xy, vec2f(12.9898, 78.233))) * 43758.5453123);
        }
        // 2D 좌표를 받아 무작위 2D 벡터 반환 (방향 계산 등에 유용)
        fn random2(st: vec2f) -> vec2f {
          let q = vec2f(
              dot(st, vec2f(127.1, 311.7)),
              dot(st, vec2f(269.5, 183.3))
          );
          return fract(sin(q) * 43758.5453123);
        }
        // 2D 좌표를 받아 무작위 3D 벡터 반환 (무작위 RGB 색상 지정에 유용)
        fn random3(st: vec2f) -> vec3f {
          let q = vec3f(
              dot(st, vec2f(127.1, 311.7)),
              dot(st, vec2f(269.5, 183.3)),
              dot(st, vec2f(419.2, 371.9))
          );
          return fract(sin(q) * 43758.5453123);
        }
        // 기본 스칼라
        fn pcg_random(seed: ptr<function, u32>) -> f32 {
          *seed = *seed * 747796405u + 2891336453u;
          let word = ((*seed >> ((*seed >> 28u) + 4u)) ^ *seed) * 277803737u;
          let result = (word >> 22u) ^ word;
          return f32(result) / 4294967295.0;
        }
        // vec2, vec3, vec4 확장 (내부에서 스칼라를 여러 번 호출)
        fn pcg_random2(seed: ptr<function, u32>) -> vec2f {
          return vec2f(pcg_random(seed), pcg_random(seed));
        }
        fn pcg_random3(seed: ptr<function, u32>) -> vec3f {
          return vec3f(pcg_random(seed), pcg_random(seed), pcg_random(seed));
        }
        fn pcg_random4(seed: ptr<function, u32>) -> vec4f {
          return vec4f(pcg_random(seed), pcg_random(seed), pcg_random(seed), pcg_random(seed));
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
        fn mask(c: vec4f) -> f32 {
          return 1.0 - luma(mix(vec3f(1.0), c.rgb, c.a));
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
  
        fn sdLine(p: vec2f, a: vec2f, b: vec2f) -> f32 {
          let pa = p - a;
          let ba = b - a;
          let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
          return length(pa - ba * h);
        }
        fn sdLineExt(p: vec2f, a: vec2f, b: vec2f) -> f32 {
          let pa = p - a;
          let ba = b - a;
          let ba_len_sq = dot(ba, ba);
          if (ba_len_sq < 1e-6) {
            return 1e6; 
          }
          let h = dot(pa, ba) / ba_len_sq; 
          return length(pa - ba * h);
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
  marching: {
    requires: ["sdf"],
    code: /* wgsl */ `
      /* marching squares
        // 각 cell의 꼭짓점 & 값
        let p00 = iuv / grid;
        let p10 = (iuv + vec2f(1.0, 0.0)) / grid;
        let p11 = (iuv + vec2f(1.0, 1.0)) / grid;
        let p01 = (iuv + vec2f(0.0, 1.0)) / grid;
        let d00 = textureSampleLevel(tex0, tex0Sampler, p00, 0.0).a;
        let d10 = textureSampleLevel(tex0, tex0Sampler, p10, 0.0).a;
        let d11 = textureSampleLevel(tex0, tex0Sampler, p11, 0.0).a;
        let d01 = textureSampleLevel(tex0, tex0Sampler, p01, 0.0).a;

        // 가장 가까운 cell의 꼭짓점의 주변 3x3 꼭짓점의 값
        let corner = iuv + round(fuv);
        var v: array<f32, 9>;
        for(var y = 0u; y < 3u; y++){
          for(var x = 0u; x < 3u; x++){
            let p = (corner+vec2f(f32(x)-1.0, f32(y)-1.0)) / grid;
            v[y * 3u + x] = textureSampleLevel(tex, texSampler, p, 0.0).a;
          }
        }
      */
      fn marchIso(a: f32, b: f32, threshold: f32) -> f32 {
        return (threshold - a) / (b - a);
      }
      fn marchCell(
        p: vec2f,
        d00: f32, d10: f32, d11: f32, d01: f32,
        t: f32,
        bLerp: bool
      ) -> f32 {
        let b00 = step(0.0, d00 - t);
        let b10 = step(0.0, d10 - t);
        let b11 = step(0.0, d11 - t);
        let b01 = step(0.0, d01 - t);
        let state = u32(b00 + b10 * 2.0 + b11 * 4.0 + b01 * 8.0);

        var bm = vec2f(0.5, 0.0);
        var tm = vec2f(0.5, 1.0);
        var lm = vec2f(0.0, 0.5);
        var rm = vec2f(1.0, 0.5);
        if(bLerp){
          bm = vec2f(marchIso(d00, d10, t), 0.0);
          tm = vec2f(marchIso(d01, d11, t), 1.0);
          lm = vec2f(0.0, marchIso(d00, d01, t));
          rm = vec2f(1.0, marchIso(d10, d11, t));
        }
        // let bm = vec2f(marchIso(d00, d10, t), 0.0);
        // let tm = vec2f(marchIso(d01, d11, t), 1.0);
        // let lm = vec2f(0.0, marchIso(d00, d01, t));
        // let rm = vec2f(1.0, marchIso(d10, d11, t));

        var d = 1e6;
        switch (state) {
          case 1, 14: { d = sdLine(p, bm, lm); }
          case 2, 13: { d = sdLine(p, bm, rm); }
          case 3, 12: { d = sdLine(p, lm, rm); }
          case 4, 11: { d = sdLine(p, tm, rm); }
          case 6, 9:  { d = sdLine(p, tm, bm); }
          case 7, 8:  { d = sdLine(p, tm, lm); }
          case 5: {
            let s = d00 * d11 - d10 * d01;
            if (s > 0.0) { d = min(sdLine(p, tm, lm), sdLine(p, bm, rm)); }
            else         { d = min(sdLine(p, tm, rm), sdLine(p, bm, lm)); }
          }
          case 10: {
            let s = d00 * d11 - d10 * d01;
            if (s > 0.0) { d = min(sdLine(p, tm, rm), sdLine(p, bm, lm)); }
            else         { d = min(sdLine(p, tm, lm), sdLine(p, bm, rm)); }
          }
          default: {}
        }
        return d;
      }
      fn marchCell_alt(
        p: vec2f,
        d00: f32, d10: f32, d11: f32, d01: f32,
        t: f32
      ) -> f32 {
        let b00 = step(0.0, d00 - t);
        let b10 = step(0.0, d10 - t);
        let b11 = step(0.0, d11 - t);
        let b01 = step(0.0, d01 - t);
        let state = u32(b00 + b10 * 2.0 + b11 * 4.0 + b01 * 8.0);
        let bm = vec2f(0.5, 0.0);
        let tm = vec2f(0.5, 1.0);
        let lm = vec2f(0.0, 0.5);
        let rm = vec2f(1.0, 0.5);

        var d = 1e6;
        switch (state) {
          case 1, 14: { d = min(sdLine(p, tm, lm), sdLine(p, bm, rm)); }
          case 2, 13: { d = min(sdLine(p, tm, rm), sdLine(p, bm, lm)); }
          case 3, 12: { d = sdLine(p, tm, bm); }
          case 4, 11: { d = min(sdLine(p, tm, lm), sdLine(p, bm, rm)); }
          case 6, 9:  { d = sdLine(p, lm, rm); }
          case 7, 8:  { d = min(sdLine(p, tm, rm), sdLine(p, bm, lm)); }
          case 5: {
            let s = d00 * d11 - d10 * d01;
            if (s > 0.0) { d = min(sdLine(p, tm, lm), sdLine(p, bm, rm)); }
            else         { d = min(sdLine(p, tm, rm), sdLine(p, bm, lm)); }
          }
          case 10: {
            let s = d00 * d11 - d10 * d01;
            if (s > 0.0) { d = min(sdLine(p, tm, rm), sdLine(p, bm, lm)); }
            else         { d = min(sdLine(p, tm, lm), sdLine(p, bm, rm)); }
          }
          default: {}
        }
        return d;
      }
      fn marchGrid(fuv: vec2f, v: array<f32, 9>, t: f32) -> f32 {
        var d = 1e6;
        let o = round(fuv);
        for (var cy = 0u; cy < 2u; cy++) {
          for (var cx = 0u; cx < 2u; cx++) {
            let lp = fuv - o - vec2f(f32(cx) - 1.0, f32(cy) - 1.0);
            d = min(d, marchCell(lp,
              v[cy * 3u + cx], v[cy * 3u + cx + 1u],
              v[(cy + 1u) * 3u + cx + 1u], v[(cy + 1u) * 3u + cx]
            , t, true));
          }
        }
        return d;
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
