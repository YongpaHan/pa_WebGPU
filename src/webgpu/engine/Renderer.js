import { GlobalUniformBlock } from "./uniforms/GlobalUniformBlock";
import { TextureResource } from "./TextureResource";

export class Renderer {
  constructor({
    canvas,
    clearColor = [0.5, 0.5, 0.5, 1],
    alphaMode = "opaque",
  } = {}) {
    this.canvas = canvas;
    this.clearColor = clearColor;

    this.adapter = null;
    this.device = null;
    this.ctx = null;
    this.format = null;
    this.alphaMode = alphaMode;

    this.passes = [];
    this.size = { width: 0, height: 0, dpr: 0 };

    this.textures = new Map();
    this.globalUniforms = null;
    this.renderCtx = null;

    this.isInitialized = false;
  }

  async init() {
    if (!navigator.gpu) throw new Error("WebGPU 이용 제한 환경");
    this.adapter = await navigator.gpu.requestAdapter();
    if (!this.adapter) throw new Error("adapter 요청 실패");
    this.device = await this.adapter.requestDevice();
    if (!this.device) throw new Error("device 요청 실패");
    this.ctx = this.canvas.getContext("webgpu");
    if (!this.ctx) throw new Error("webgpu context 생성 실패");
    this.format = navigator.gpu.getPreferredCanvasFormat();

    this.ctx.configure({
      device: this.device,
      format: this.format,
      alphaMode: this.alphaMode,
    });

    this.globalUniforms = new GlobalUniformBlock({ device: this.device });
    this._globalUniformValues = {};
    this.renderCtx = {
      renderer: this,
      device: this.device,
      format: this.format,
      canvas: this.canvas,
      globalUniforms: this.globalUniforms,
      // frame: {
      //   time: 0,
      //   dt: 0,
      //   width: 1,
      //   height: 1,
      // },
    };

    this.resize();
    this.isInitialized = true;

    for (const pass of this.passes) {
      this._initPass(pass);
    }
  }

  addPass(pass) {
    if (!pass) return;
    if (this.passes.includes(pass)) return;

    this.passes.push(pass);
    this._initPass(pass);
  }
  removePass(pass) {
    const index = this.passes.indexOf(pass);
    if (index === -1) return;

    this.passes.splice(index, 1);
    pass?.destroy?.();
  }

  //텍스처
  async createTexture(name, options = {}) {
    if (!this.device) throw new Error("Renderer: device가 필요합니다.");
    if (!name) throw new Error("텍스처 이름(문자열) 값이 필요합니다.");

    this.removeTexture(name);
    const opts = { ...options };
    const hasSource = Boolean(opts.source);
    const hasWidthInput = Number.isFinite(options.width);
    const hasHeightInput = Number.isFinite(options.height);
    if (!opts.source) {
      if (!opts.width) opts.width = this.size.width;
      if (!opts.height) opts.height = this.size.height;
      if (!opts.format) opts.format = this.format;
    }

    const resource = new TextureResource({ device: this.device, label: name });
    if (opts.source) await resource.createFromSource(opts);
    else resource.createEmpty(opts);

    const inferredAutoResize = !hasSource && !hasWidthInput && !hasHeightInput;
    const autoResize = hasSource
      ? false
      : options.autoResize ?? inferredAutoResize;
    resource.setAutoResize(autoResize);

    this.textures.set(name, resource);
    return resource;
  }
  removeTexture(name) {
    if (!name) throw new Error("텍스처 이름(문자열) 값이 필요합니다.");

    const resource = this.textures.get(name);
    if (resource) {
      resource.destroy?.();
      this.textures.delete(name);
    }
    return Boolean(resource);
  }
  getTexture(name) {
    if (!name) throw new Error("텍스처 이름(문자열) 값이 필요합니다.");
    return this.textures.get(name) ?? null;
  }
  _updateTexture() {
    for (let v of this.textures.values()) {
      v?.update?.();
    }
  }

  _resizeAutoTextures(width, height) {
    for (const [name, resource] of this.textures.entries()) {
      if (!resource?.autoResize) continue;
      try {
        resource.resize?.(width, height);
      } catch (err) {
        console.error(`[Renderer] auto-resize texture failed: ${name}`, err);
      }
    }
  }
  _notifyResize() {
    if (!this.renderCtx) return;
    for (const pass of this.passes) {
      pass?.onResize?.(this.renderCtx);
    }
  }
  _initPass(pass) {
    if (!pass || !this.isInitialized || !this.renderCtx) return;
    if (typeof pass.init !== "function") return;
    if (pass.isInitialized) return;
    pass.init(this.renderCtx);
  }

  setGlobalUniforms(v = {}) {
    this._globalUniformValues = { ...this._globalUniformValues, ...v };
  }

  renderFrame(time, dt) {
    if (!this.isInitialized || !this.device || !this.ctx) return;

    const resized = this.resize();
    if (resized) {
      this._resizeAutoTextures(this.size.width, this.size.height);
      this._notifyResize();
    }
    //ctx.frame 업데이트
    // this.renderCtx.frame = {
    //   time: time,
    //   dt: dt,
    //   size: this.size,
    // };
    //글로벌 유니폼 세팅 & 업로드
    this.globalUniforms.setUniforms({
      time,
      deltaTime: dt,
      resolution: [this.canvas.width, this.canvas.height],
      ...this._globalUniformValues,
    });
    this.globalUniforms.upload();
    //텍스처(동적 텍스처의 경우) 업데이트
    this._updateTexture();

    const encoder = this.device.createCommandEncoder({
      label: "Renderer Command Encoder",
    });
    const screenView = this.ctx.getCurrentTexture().createView();

    if (this.passes.length === 0) {
      const clearPass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: screenView,
            clearValue: this.clearColor,
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      clearPass.end();
      this.device.queue.submit([encoder.finish()]);
      return;
    }

    for (const pass of this.passes) {
      pass?.encode?.(encoder, screenView);
    }

    this.device.queue.submit([encoder.finish()]);
  }

  resize() {
    if (!this.canvas || !this.ctx || !this.device || !this.format) return false;

    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));

    const changed =
      this.canvas.width !== width || this.canvas.height !== height;
    if (changed) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.ctx.configure({
        device: this.device,
        format: this.format,
        alphaMode: this.alphaMode,
      });
    }

    this.size.width = width;
    this.size.height = height;
    this.size.dpr = dpr;

    return changed;
  }

  dispose() {
    this.globalUniforms?.destroy?.();

    for (const pass of this.passes) {
      pass?.destroy?.();
    }
    this.passes = [];

    try {
      this.ctx?.unconfigure?.();
    } catch (_) {
      // 브라우저마다 unconfigure 지원 여부가 달라 무시합니다.
    }

    this.adapter = null;
    this.device = null;
    this.ctx = null;
    this.format = null;
    for (const resource of this.textures.values()) {
      resource?.destroy?.();
    }
    this.textures.clear();
    this.isInitialized = false;
  }
}
