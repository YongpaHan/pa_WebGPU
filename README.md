# WebGPU Template

현재 구조는 아래 3가지를 중심으로 돌아갑니다.

- `Renderer`: WebGPU 초기화, 캔버스 리사이즈, 전역 유니폼, 프레임 루프 관리
- `RenderPass`: 파이프라인 생성, 로컬 유니폼/텍스처 바인딩, draw 호출
- `buildShader`: WGSL 코드 조립과 bind group 계약(contract) 생성

이 문서는 "이 템플릿이 지금 무엇을 지원하는지", "어떤 순서로 써야 하는지", "새 셰이더/패스를 어떻게 추가하는지"를 기준으로 작성되었습니다.

## 1. 이 템플릿으로 할 수 있는 것

현재 코드 기준으로 지원하는 범위는 다음과 같습니다.

- WebGPU 캔버스 초기화
- 전역 유니폼 자동 제공
  - `global.resolution`
  - `global.time`
  - `global.deltaTime`
- `buildShader()` 기반 로컬 유니폼 선언
- 텍스처/샘플러 자동 바인딩
- 풀스크린 쿼드 렌더링
- 오프스크린 렌더 타깃(texture render target)
- 캔버스 리사이즈 시 화면/오프스크린 텍스처 자동 재생성
- 간단한 WGSL include 라이브러리 사용

아직 이 템플릿이 직접 제공하지 않는 것:

- compute pass 래퍼
- scene graph
- material system
- camera / mesh loader
- post-processing graph editor

## 2. 빠른 시작

### 요구 조건

- Node.js
- `npm`
- WebGPU를 사용할 수 있는 브라우저

### 실행

```bash
npm install
npm run dev
```

브라우저에서 개발 서버를 열면 `src/main.js`가 실행됩니다.

빌드:

```bash
npm run build
```

미리보기:

```bash
npm run preview
```

## 3. 지금 예제가 실제로 하는 일

현재 진입점은 `src/main.js`입니다.

흐름은 매우 단순합니다.

1. 캔버스를 만든다.
2. `main.js`가 `runSketch({ canvas })`를 호출한다.
3. `src/sketches/basic/index.js`가 타이머, gesture, `Renderer`를 만든다.
4. 스케치 전용 `shader.js`, `pass.js`를 조합한다.
5. `renderer.init()`으로 WebGPU를 초기화한다.
6. 스케치 asset을 로드하고 패스를 등록한다.
7. `requestAnimationFrame` 루프에서 전역 유니폼을 갱신하고 `renderer.renderFrame(time, dt)`를 호출한다.

핵심 코드 형태는 아래와 같습니다.

```js
// src/main.js
const canvas = createCanvas();
await runSketch({ canvas });
```

```js
// src/sketches/basic/index.js
const timer = createTimer();
const gesture = createGesture(canvas);
const renderer = new Renderer({ canvas });
const { pass } = createPass({ shader });

await renderer.init();
await renderer.createTexture("test_tex", {
  source: assets.testTexture,
});

renderer.addPass(pass);

function frame() {
  const dt = timer.tick();
  time += dt;
  renderer.setGlobalUniforms(gesture.uniforms);
  renderer.renderFrame(time, dt);
  requestAnimationFrame(frame);
}
```

## 4. 추천 사용 순서

이 템플릿은 아래 순서로 쓰는 것이 가장 안전합니다.

1. 셰이더를 만든다.
2. 패스를 만든다.
3. `await renderer.init()`을 호출한다.
4. 셰이더 contract에 선언한 이름으로 텍스처를 만든다.
5. `renderer.addPass(pass)`를 호출한다.
6. 프레임 루프에서 `renderer.renderFrame(time, dt)`를 호출한다.

이 순서를 추천하는 이유:

- `createTexture()`는 `device`가 있어야 하므로 `renderer.init()` 이후에만 호출할 수 있습니다.
- `RenderPass`는 초기화 시점에 필요한 텍스처를 찾습니다.
- 그래서 텍스처가 필요한 패스는 보통 `addPass()` 전에 텍스처 준비가 끝나 있어야 합니다.

## 5. 핵심 구성요소

### Renderer

파일: `src/webgpu/engine/Renderer.js`

역할:

- WebGPU adapter / device / context 초기화
- 캔버스 포맷 설정
- 전역 유니폼(`group(0)`) 업데이트
- 프레임마다 패스 실행
- 리사이즈 감지
- 텍스처 레지스트리 관리

주요 메서드:

- `await renderer.init()`
- `renderer.addPass(pass)`
- `renderer.removePass(pass)`
- `await renderer.createTexture(name, options)`
- `renderer.getTexture(name)`
- `renderer.removeTexture(name)`
- `renderer.renderFrame(time, dt)`
- `renderer.dispose()`

`renderFrame(time, dt)`를 호출하면 내부에서 다음이 자동으로 일어납니다.

- 캔버스 리사이즈 확인
- `autoResize` 텍스처 리사이즈
- 각 pass에 `onResize()` 호출
- 전역 유니폼 업로드
- 동적 텍스처 업데이트
- 패스 인코딩 및 submit

### RenderPass

파일: `src/webgpu/engine/RenderPass.js`

역할:

- 셰이더 모듈 생성
- 파이프라인 생성
- local uniform / texture bind group 생성
- geometry bind + draw
- 화면 또는 오프스크린 텍스처에 렌더링

생성자에서 자주 쓰는 옵션:

- `label`
- `shader`
- `shaderCode`
- `geometry`
- `textures`
- `target`
- `clearMode`
- `clearColor`

실무적으로 기억할 포인트:

- `shader`에 `{ code, contract }`를 넘기면 contract 기반 바인딩을 자동 사용합니다.
- `shaderCode`만 넘기는 fallback도 가능하지만, 새 작업은 `buildShader()` 기반이 더 안전합니다.
- `setUniforms()`는 `init` 전에 호출해도 내부에 잠시 저장됐다가 초기화 후 반영됩니다.
- 로컬 유니폼이 없는 셰이더에 `setUniforms()`를 호출하면 무시됩니다.

### buildShader

파일: `src/webgpu/engine/shaders/ShaderBuilder.js`

역할:

- 전역 유니폼 WGSL 자동 포함
- 로컬 유니폼 구조체/바인딩 코드 자동 생성
- 텍스처/샘플러 선언 자동 생성
- include 코드 병합
- define 상수 삽입
- 셰이더 계약(contract) 생성

반환값:

```js
const shader = buildShader(...);

shader.code;
shader.contract;
```

즉, `RenderPass`는 문자열 WGSL만 받는 것이 아니라 "WGSL + 바인딩 계약" 묶음도 받을 수 있습니다.

### TextureResource

파일: `src/webgpu/engine/TextureResource.js`

역할:

- 이미지/비디오/캔버스 기반 텍스처 생성
- 빈 렌더 타깃 텍스처 생성
- 동적 소스 업데이트
- 오토 리사이즈

사용 방식은 크게 두 가지입니다.

1. 소스 기반 텍스처

```js
await renderer.createTexture("albedo", {
  source: "/images/512.jpg",
});
```

2. 빈 렌더 타깃 텍스처

```js
await renderer.createTexture("sceneColor", {});
```

빈 텍스처를 만들 때 `width`, `height`를 생략하면:

- 현재 캔버스 크기로 생성되고
- 기본 포맷은 현재 캔버스 포맷을 따라가고
- `autoResize`가 자동으로 켜집니다.

### Geometry

파일: `src/webgpu/engine/Geometry.js`

역할:

- vertex/index buffer 생성
- attribute layout 생성
- draw / drawIndexed 호출

기본 예제는 풀스크린 쿼드 geometry를 사용합니다. 그래서 셰이더 실험이나 후처리용 화면 이펙트를 빠르게 만들기 좋습니다.

## 6. 바인딩 규약

이 프로젝트는 바인딩 규약이 단순합니다.

### group(0): 전역 유니폼

항상 고정입니다.

```wgsl
@group(0) @binding(0)
var<uniform> global: GlobalUniforms;
```

사용 가능한 값:

- `global.resolution`
- `global.time`
- `global.deltaTime`

정의 위치:

- `src/shaders/global/globalUniform.wgsl.js`

### group(1): 로컬 리소스

`buildShader()`가 자동 구성합니다.

- 로컬 유니폼이 있으면 `binding(0)`
- 텍스처/샘플러는 그 다음 슬롯부터 연속 배치
- 텍스처 1개당 2칸 사용
  - texture
  - sampler

예를 들어:

```js
buildShader({
  uniforms: {
    gain: "f32",
  },
  textures: ["albedoTex", { name: "noiseTex", as: "noise" }],
  shader: `...`,
});
```

대략 이런 규약이 만들어집니다.

```wgsl
@group(1) @binding(0) var<uniform> local: LocalUniforms;

@group(1) @binding(1) var albedoTex: texture_2d<f32>;
@group(1) @binding(2) var albedoTexSampler: sampler;

@group(1) @binding(3) var noise: texture_2d<f32>;
@group(1) @binding(4) var noiseSampler: sampler;
```

중요:

- 텍스처 이름은 shader contract 기준입니다.
- 즉 `textures: ["test_tex"]`라고 선언했다면, 보통 `renderer.createTexture("test_tex", ...)`가 필요합니다.

## 7. 새 셰이더 만드는 방법

가장 쉬운 출발점은 `src/webgpu/shaders/base/basicShader.js` 또는 `src/sketches/basic/shader.js`를 복사하는 것입니다.

예제:

```js
import { buildShader } from "../../webgpu/engine/shaders/ShaderBuilder";

export const myShader = buildShader({
  includes: ["math", "noise"],
  uniforms: {
    gain: "f32",
    speed: "f32",
  },
  textures: ["mainTex", { name: "maskTex", as: "mask" }],
  defines: {
    PI: 3.141592,
    STEPS: 8,
    USE_MASK: true,
  },
  validate: true,
  shader: /* wgsl */ `
struct vOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vertexMain(@location(0) pos: vec2f) -> vOut {
  var out: vOut;
  out.position = vec4f(pos, 0.0, 1.0);
  out.uv = pos * 0.5 + vec2f(0.5);
  return out;
}

@fragment
fn fragmentMain(in: vOut) -> @location(0) vec4f {
  let uv = in.uv;
  let t = global.time * local.speed;
  let base = textureSample(mainTex, mainTexSampler, uv);
  let n = noise21(uv * 10.0 + t);
  let color = base.rgb * (local.gain + n * 0.2);
  return vec4f(color, 1.0);
}
`,
});
```

이때 자동으로 생기는 것:

- `global` uniform
- `local` uniform
- `mainTex`, `mainTexSampler`
- `mask`, `maskSampler`
- `const PI = 3.141592;`
- `const STEPS = 8;`
- include 함수들

### validate 옵션

`validate: true`를 켜면 최소한 아래를 검사합니다.

- `vertexMain` 존재 여부
- `fragmentMain` 존재 여부
- include 이름 오류
- define 이름 충돌
- texture 이름 충돌

새 셰이더를 처음 만들 때는 `true`가 더 낫습니다.

## 8. include 라이브러리

파일: `src/webgpu/shaders/global/function.wgsl.js`

현재 제공되는 include 이름:

- `math`
- `color`
- `sdf`
- `noise`

예:

```js
buildShader({
  includes: ["math", "color"],
  shader: `...`,
});
```

의존성도 자동 처리됩니다.

- `color`는 내부적으로 `math`를 요구합니다.

## 9. 새 패스 만드는 방법

현재는 `src/sketches/basic/pass.js`가 가장 좋은 예제입니다.

기본 형태:

```js
import { RenderPass } from "../../webgpu/engine/RenderPass";

export function createMyPass({ shader }) {
  const geometry = {
    topology: "triangle-list",
    attributes: [
      {
        data: new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]),
        arrayStride: 8,
        attributes: [{ location: 0, format: "float32x2", offset: 0 }],
      },
    ],
    index: [0, 1, 2, 0, 2, 3],
  };

  const pass = new RenderPass({
    label: "MyPass",
    shader,
    geometry,
  });

  return { pass, geometry };
}
```

그리고 메인에서는:

```js
const { pass } = createMyPass({ shader: myShader });

await renderer.init();
await renderer.createTexture("mainTex", { source: "/images/512.jpg" });

pass.setUniforms({
  gain: 1.2,
  speed: 0.8,
});

renderer.addPass(pass);
```

## 10. 오프스크린 렌더 타깃 사용법

이 템플릿은 "한 패스가 텍스처에 그리고, 다음 패스가 그 텍스처를 샘플링"하는 구조를 지원합니다.

예:

```js
await renderer.init();

await renderer.createTexture("sceneColor", {});
await renderer.createTexture("inputTex", { source: "/images/512.jpg" });

const { pass: scenePass } = createPass({ shader: firstShader });
const { pass: postPass } = createPass({ shader: postShader });

scenePass.setTarget("sceneColor");

renderer.addPass(scenePass);
renderer.addPass(postPass);
```

여기서 중요한 점:

- `sceneColor`는 빈 텍스처이므로 렌더 타깃으로 쓸 수 있습니다.
- `postShader` 쪽 `buildShader({ textures: ["sceneColor"] })`처럼 같은 이름을 선언하면 자동으로 registry에서 찾습니다.
- 리사이즈 시 `sceneColor`는 자동 재생성되고, 관련 bind group도 자동 갱신됩니다.

`target`은 두 가지 모두 지원합니다.

- 텍스처 이름 문자열
- `TextureResource` 인스턴스

## 11. 디렉터리 가이드

```txt
src/
  main.js                    # 실행 진입점
  sketches/
    basic/
      index.js               # 현재 실행되는 스케치
      shader.js              # basic 스케치 전용 셰이더
      pass.js                # basic 스케치 전용 패스
      assets.js              # basic 스케치 asset 경로
  webgpu/
    engine/
      Renderer.js            # 초기화, 프레임 루프, 텍스처 레지스트리
      RenderPass.js          # 파이프라인, bind group, draw
      Geometry.js            # vertex/index buffer 관리
      TextureResource.js     # 텍스처 생성/업데이트/리사이즈
      shaders/
        Include.js           # include 해석
        ShaderBuilder.js     # WGSL + contract 생성
      uniforms/
        UniformBlock.js      # 일반 uniform buffer 래퍼
        GlobalUniformBlock.js # global uniform block
    lib/
      gesture.js             # gesture controller 라이브러리
    shaders/
      base/
        basicShader.js       # 새 셰이더 시작용 템플릿
      global/
        globalUniform.wgsl.js # global uniform 선언
        function.wgsl.js     # include 함수 라이브러리
    utils/
      canvas.js
      gesture.js
      timer.js
public/
  images/512.jpg
  fonts/
    pa_Regular/
      pa_Regular.png
      pa_Regular.json
```

처음 수정할 때는 보통 아래 4개만 보면 됩니다.

- `src/main.js`
- `src/sketches/basic/index.js`
- `src/sketches/basic/shader.js`
- `src/sketches/basic/pass.js`

## 12. 자주 막히는 지점

### 1) `WebGPU 이용 제한 환경`

원인:

- 브라우저가 WebGPU를 지원하지 않거나 비활성화된 경우

확인:

- WebGPU 지원 브라우저에서 열기
- 브라우저 설정/플래그 상태 확인

### 2) `shader.contract 텍스처 '...'를 찾을 수 없습니다`

원인:

- 셰이더에서 선언한 텍스처 이름과 실제 생성한 텍스처 이름이 다름
- `addPass()` 전에 텍스처를 만들지 않음

해결:

```js
await renderer.createTexture("test_tex", { source: "/images/512.jpg" });
renderer.addPass(pass);
```

### 3) `setUniforms()`가 먹지 않는 것처럼 보임

원인:

- 셰이더에 `uniforms` 선언이 없음

해결:

```js
uniforms: {
  gain: "f32",
}
```

그리고 WGSL에서 `local.gain`을 사용해야 합니다.

### 4) 검은 화면이 뜸

먼저 아래를 순서대로 확인하세요.

- `renderer.init()`이 호출되었는가
- `renderer.addPass(pass)`가 호출되었는가
- 셰이더에 `vertexMain`, `fragmentMain`이 있는가
- geometry attribute location이 WGSL 입력과 맞는가
- contract에 선언한 텍스처가 실제로 만들어졌는가
- 외부 이미지 URL이 실패하지 않았는가

### 5) 셰이더 문법 실수를 빨리 잡고 싶음

`buildShader()`에서 `validate: true`를 켜세요.

## 13. 이 프로젝트를 확장할 때 권장하는 방식

가장 안전한 확장 순서는 이렇습니다.

1. `basicShader.js`를 복사해서 새 셰이더를 만든다.
2. `quadPass.js`를 복사해서 새 패스를 만든다.
3. `main.js`에서 텍스처 생성 순서를 맞춘다.
4. 필요하면 offscreen target을 추가한다.
5. 그 다음에 geometry 종류나 렌더 패스 수를 늘린다.

처음부터 엔진 구조를 크게 바꾸기보다, `buildShader -> RenderPass -> Renderer` 흐름을 유지한 채 예제를 하나씩 늘리는 편이 훨씬 덜 헷갈립니다.

## 14. 한 줄 요약

이 템플릿은 "셰이더 contract 기반으로 local uniform/texture를 자동 바인딩해 주는 WebGPU 렌더 패스 템플릿"입니다.

처음에는 아래만 기억하면 됩니다.

- 셰이더는 `buildShader()`로 만든다.
- 텍스처 이름은 셰이더에서 선언한 이름과 같아야 한다.
- `renderer.init()` 후 텍스처를 만들고, 그 다음 `renderer.addPass(pass)`를 호출한다.
- 프레임 루프에서는 `renderer.renderFrame(time, dt)`만 호출하면 된다.
