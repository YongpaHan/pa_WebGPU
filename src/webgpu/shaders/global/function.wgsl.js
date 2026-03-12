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
  `,
  },
};
