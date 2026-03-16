# 07_drawing

WebGPU 기반 드로잉/제너러티브 스케치 실험을 위한 Vite 프로젝트입니다.  
이 저장소는 작은 렌더링 엔진 위에 스케치를 빠르게 올릴 수 있게 구성되어 있고, `RenderPass`와 `ComputePass`를 같은 프레임 루프에서 조합할 수 있습니다.

현재 기본 실행 스케치는 `src/sketches/260313`이며, MSDF 폰트 atlas와 gesture 입력을 이용해 텍스트 기반의 잔상형 이미지를 만듭니다.

## 핵심 특징

- Vite 기반의 가벼운 개발 환경
- WebGPU 캔버스 초기화와 자동 리사이즈
- `Renderer -> Pass -> Shader` 구조의 단순한 스케치 아키텍처
- 전역 유니폼 자동 제공
  - `global.time`
  - `global.deltaTime`
  - `global.resolution`
- gesture 유틸과 결합 가능한 입력 유니폼
- `buildShader()` 기반의 렌더 셰이더 작성
- `buildComputeShader()` 기반의 컴퓨트 셰이더 작성
- 텍스처, 샘플러, 스토리지 버퍼/텍스처 계약(contract) 자동 생성
- offscreen target, ping-pong 패턴, compute -> render 순차 실행 지원

## 빠른 시작

### 요구사항

- Node.js
- npm
- WebGPU 지원 브라우저

### 설치 및 실행

```bash
npm install
npm run dev
```

기본 개발 서버는 Vite를 사용합니다.

### 빌드

```bash
npm run build
```

### 빌드 결과 미리보기

```bash
npm run preview
```

### 모바일 확인용 터널 실행

```bash
npm run mobile
```

이 스크립트는 로컬 Vite 서버를 띄운 뒤 `cloudflared` 터널을 연결합니다.  
실행 전 `cloudflared`가 설치되어 있어야 합니다.

## 현재 실행 진입점

앱 시작 파일은 `src/main.js`입니다.

```js
import { runSketch } from "./sketches/260313/sketch";
```

즉, 현재 기본 데모는 `src/sketches/260313/sketch.js`입니다.

다른 스케치를 실행하려면 `src/main.js`의 import 경로만 바꾸면 됩니다.

예시:

```js
import { runSketch } from "./sketches/0_base/0_plain/sketch";
```

## 프로젝트 구조

```text
.
├─ public/
│  ├─ fonts/
│  │  ├─ AGM/
│  │  └─ pa_Regular/
│  └─ images/
├─ scripts/
│  └─ mobile-dev.mjs
├─ src/
│  ├─ main.js
│  ├─ style.css
│  ├─ sketches/
│  │  ├─ 0_base/
│  │  │  ├─ 0_plain/
│  │  │  └─ 0_starter/
│  │  ├─ 260312/
│  │  ├─ 260313/
│  │  └─ 260316/
│  └─ webgpu/
│     ├─ engine/
│     ├─ shaders/
│     └─ utils/
├─ index.html
└─ vite.config.js
```

### 디렉터리 역할

- `src/main.js`
  - 캔버스를 만들고 현재 선택된 스케치를 실행합니다.
- `src/sketches/`
  - 날짜별 또는 목적별 스케치 모음입니다.
- `src/sketches/0_base/`
  - 새 작업을 시작할 때 복사해 쓰기 좋은 베이스 템플릿입니다.
- `src/webgpu/engine/`
  - `Renderer`, `RenderPass`, `ComputePass`, uniform/texture 관리 코드가 들어 있습니다.
- `src/webgpu/shaders/`
  - 공용 셰이더 조각과 베이스 셰이더가 있습니다.
- `src/webgpu/utils/`
  - canvas 생성, gesture 처리, timer, MSDF font 로더 등의 유틸리티가 있습니다.
- `public/fonts/`
  - MSDF 폰트 atlas 리소스가 들어 있습니다.

## 새 스케치 시작 방법

가장 빠른 시작 경로는 `src/sketches/0_base/0_plain`을 복사해서 새 폴더를 만드는 방식입니다.

추천 순서:

1. `src/sketches/0_base/0_plain`을 새 폴더로 복사
2. `sketch.js`에서 사용할 pass와 shader 연결
3. `src/main.js`에서 새 스케치를 import
4. 필요하면 텍스처를 `renderer.createTexture()`로 생성
5. 프레임 루프에서 `renderer.renderFrame(time, dt)` 호출

## 스케치 구성 방식

스케치는 대체로 아래 흐름을 따릅니다.

1. `createCanvas()`로 캔버스 생성
2. `Renderer` 초기화
3. `RenderPass` 또는 `ComputePass` 생성
4. 필요한 텍스처/스토리지 생성
5. `renderer.addPass()` 순서 설정
6. `requestAnimationFrame()` 루프에서 업데이트 후 렌더

기본 형태:

```js
const renderer = new Renderer({ canvas });
await renderer.init();

renderer.addPass(passA);
renderer.addPass(passB);

function animate() {
  renderer.renderFrame(time, dt);
  requestAnimationFrame(animate);
}
```

여기서 `renderer.addPass()` 순서가 실제 실행 순서입니다.  
compute 결과를 render에서 사용하려면 `ComputePass`를 먼저 추가하면 됩니다.

## 핵심 구성요소

### Renderer

파일: `src/webgpu/engine/Renderer.js`

역할:

- WebGPU adapter/device/context 초기화
- 캔버스 리사이즈 반영
- 전역 유니폼 업로드
- 텍스처 생성/조회/삭제
- 등록된 pass를 프레임마다 순서대로 실행

자주 쓰는 메서드:

- `await renderer.init()`
- `renderer.addPass(pass)`
- `renderer.renderFrame(time, dt)`
- `await renderer.createTexture(name, options)`
- `renderer.getTexture(name)`
- `renderer.setGlobalUniforms(values)`

### RenderPass

파일: `src/webgpu/engine/RenderPass.js`

역할:

- render pipeline 생성
- geometry draw
- local uniform, texture, storage 바인딩
- 화면 또는 offscreen target 렌더링

### ComputePass

파일: `src/webgpu/engine/ComputePass.js`

역할:

- compute pipeline 생성
- global/local bind group 바인딩
- `dispatchWorkgroups()` 실행
- storage texture / storage buffer / sampled texture 리소스 처리

### ShaderBuilder

파일: `src/webgpu/engine/shaders/ShaderBuilder.js`

제공 함수:

- `buildShader(config)`
- `buildComputeShader(config)`

두 함수 모두 셰이더 코드와 리소스 계약 정보를 함께 만듭니다.  
compute 셰이더는 dispatch 계산 헬퍼도 제공합니다.

## 전역 유니폼과 입력

렌더 루프에서 `renderer.renderFrame(time, dt)`를 호출하면 전역 유니폼이 자동 갱신됩니다.

사용 가능한 대표 값:

- `global.time`
- `global.deltaTime`
- `global.resolution`

gesture 유틸을 연결하면 아래 입력값도 함께 넘길 수 있습니다.

- `mouse`
- `gestureTransform`
- `gestureState`
- `touches`

실제 사용 예시는 `src/webgpu/utils/gesture.js`와 `src/sketches/260313/sketch.js`를 참고하면 됩니다.

## 렌더 셰이더 작성 예시

```js
import { buildShader } from "../../webgpu/engine/shaders/ShaderBuilder";

export const shader = buildShader({
  includes: ["math"],
  uniforms: { gain: "f32" },
  textures: ["mainTex"],
  storages: {},
  validate: true,
  shader: /* wgsl */ `
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vertexMain(@location(0) pos: vec2f) -> VertexOut {
  var out: VertexOut;
  out.position = vec4f(pos, 0.0, 1.0);
  out.uv = pos * 0.5 + vec2f(0.5);
  return out;
}

@fragment
fn fragmentMain(in: VertexOut) -> @location(0) vec4f {
  let tex = textureSample(mainTex, mainTexSampler, in.uv);
  return vec4f(tex.rgb * local.gain, 1.0);
}
`,
});
```

## 컴퓨트 셰이더 작성 예시

```js
import { buildComputeShader } from "../../webgpu/engine/shaders/ShaderBuilder";

export const computeShader = buildComputeShader({
  textures: ["simRead"],
  storageTextures: [
    { name: "simWrite", access: "write", format: "rgba16float" },
  ],
  workgroupSize: [8, 8, 1],
  validate: true,
  shader: /* wgsl */ `
fn computeMain(@builtin(global_invocation_id) gid: vec3u) {
  let size = textureDimensions(simWrite);
  if (gid.x >= size.x || gid.y >= size.y) {
    return;
  }

  let uv = (vec2f(gid.xy) + 0.5) / vec2f(size);
  let src = textureSample(simRead, simReadSampler, uv);
  textureStore(simWrite, vec2i(gid.xy), vec4f(src.rgb, 1.0));
}
`,
});
```

주의:

- `@compute`, `@workgroup_size`는 직접 쓰지 않고 builder 옵션으로 지정합니다.
- 셰이더에서 선언한 이름과 실제 리소스 이름은 일치해야 합니다.

## 자주 사용하는 패턴

### 1. 화면 전체 쿼드 렌더링

기본 `RenderPass` 예제는 대부분 `[-1, -1]`부터 `[1, 1]`까지의 풀스크린 쿼드를 사용합니다.

참고 파일:

- `src/sketches/0_base/0_plain/passes/pass.js`
- `src/sketches/260313/passes/pass.js`

### 2. Ping-pong 텍스처

프레임마다 이전 결과를 읽고 새 결과를 쓰는 방식입니다.

```js
let readTex = texA;
let writeTex = texB;

function updateFrame() {
  computePass.setTexture("simRead", readTex);
  computePass.setStorageTexture("simWrite", writeTex);

  renderer.renderFrame(time, dt);
  [readTex, writeTex] = [writeTex, readTex];
}
```

### 3. MSDF 폰트 사용

현재 프로젝트에는 `loadMsdfFont()` 유틸과 `public/fonts/` 리소스가 준비되어 있습니다.

예시:

```js
const font = await loadMsdfFont("/fonts/AGM");
await renderer.createTexture("fontAtlas", {
  source: font.atlas,
  flipY: false,
});
```

관련 파일:

- `src/webgpu/utils/msdfFont.js`
- `public/fonts/AGM/`

## 자주 막히는 지점

### WebGPU가 시작되지 않을 때

- 브라우저가 WebGPU를 지원하지 않거나 비활성화된 상태일 수 있습니다.
- `navigator.gpu`가 없으면 `Renderer.init()`에서 오류가 납니다.

### 셰이더 리소스 연결이 안 될 때

- shader에서 선언한 이름과 실제 연결한 texture/storage 이름이 다른지 확인합니다.
- 필요한 텍스처를 `renderer.addPass()` 전에 만들었는지 확인합니다.

### compute 결과가 render에 반영되지 않을 때

- pass 순서가 `compute -> render`인지 확인합니다.
- storage texture usage에 `GPUTextureUsage.STORAGE_BINDING`이 포함됐는지 확인합니다.
- ping-pong 스왑 시점이 `renderFrame()` 전후 중 어디인지 다시 확인합니다.

### 유니폼이 반영되지 않을 때

- shader 설정에서 `uniforms`를 선언하지 않으면 `local` 블록이 생기지 않습니다.

## 참고할 만한 파일

- `src/main.js`
- `src/sketches/0_base/0_plain/sketch.js`
- `src/sketches/260313/sketch.js`
- `src/webgpu/engine/Renderer.js`
- `src/webgpu/engine/RenderPass.js`
- `src/webgpu/engine/ComputePass.js`
- `src/webgpu/engine/shaders/ShaderBuilder.js`

## 한 줄 요약

이 프로젝트는 빠르게 WebGPU 스케치를 실험하기 위한 작은 프레임워크이자, render/compute 조합 작업을 반복하기 좋은 드로잉 플레이그라운드입니다.
