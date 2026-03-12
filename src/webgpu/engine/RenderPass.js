import { makeShaderDataDefinitions } from "webgpu-utils";
import { UniformBlock } from "./uniforms/UniformBlock";
import { Geometry } from "./Geometry";

const resourceIdentityMap = new WeakMap();
let nextResourceIdentityId = 1;

function getResourceIdentity(value) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return String(value);
  }
  if (!resourceIdentityMap.has(value)) {
    resourceIdentityMap.set(value, nextResourceIdentityId++);
  }
  return String(resourceIdentityMap.get(value));
}

export class RenderPass {
  constructor({
    label = "Render pass",
    clearMode = "clear",
    clearColor = [0.5, 0.5, 0.5, 1],
    target = null,
    shader = null,
    shaderCode = null,
    geometry = null,
    textures = [],
  } = {}) {
    this.label = label;
    this.geometry = geometry;
    this.shader = shader;
    this.shaderCode = shader?.code ?? shaderCode;
    this.shaderContract = shader?.contract ?? null;

    this.clearMode = clearMode;
    this.clearColor = clearColor;

    this.target = target;
    this.device = null;
    this.format = null;
    this.canvas = null;

    this.shaderModule = null;
    this.pipelineLayout = null;
    this.pipeline = null;
    this.pipelineFormat = null;
    this.pipelineCache = new Map();
    this.uniforms = null;
    this.pendingUniforms = {};
    this.textures = textures;
    this.localBindGroupLayout = null;
    this.localBindGroup = null;
    this.localBindingPlan = null;
    this._localLayoutKey = null;
    this._localResourceKey = null;

    this.ownsGeometry = false;
    this._warnedNoLocalUniform = false;

    this.isInitialized = false;
  }

  init(ctx) {
    if (this.shader && typeof this.shader === "object") {
      if (typeof this.shader.code === "string") {
        this.shaderCode = this.shader.code;
      }
      if (this.shader.contract) {
        this.shaderContract = this.shader.contract;
      }
    }

    if (!this.shaderCode) throw new Error("셰이더 코드가 필요합니다.");
    if (!this.geometry) throw new Error("지오메트리가 필요합니다.");

    this.renderer = ctx.renderer;
    this.device = ctx.device;
    this.format = ctx.format;
    this.canvas = ctx.canvas;
    this.globalUniforms = ctx.globalUniforms;

    const isGeometryInstance =
      this.geometry &&
      typeof this.geometry.getVBL === "function" &&
      typeof this.geometry.bind === "function" &&
      typeof this.geometry.draw === "function";

    if (!isGeometryInstance) {
      this.geometry = new Geometry({
        device: this.device,
        ...(this.geometry || {}),
      });
      this.ownsGeometry = true;
    }

    this.shaderModule = this.device.createShaderModule({
      label: "",
      code: this.shaderCode,
    });

    //글로벌유니폼
    const globalLayout = this.globalUniforms?.getBindGroupLayout?.();
    if (!globalLayout) {
      throw new Error("RenderPass: global bindGroupLayout을 찾을 수 없습니다.");
    }
    const bindGroupLayouts = [globalLayout];
    // 로컬 리소스 (uniform + textures)
    const defs = makeShaderDataDefinitions(this.shaderCode);
    const contractGroup1 = this.shaderContract?.group1;
    const hasContractGroup1 = Boolean(
      contractGroup1 && typeof contractGroup1 === "object"
    );
    const contractUniform = this.shaderContract?.group1?.uniform;
    const uniformVarName = contractUniform?.varName ?? "local";
    const localStruct = contractUniform
      ? defs.uniforms?.[uniformVarName] ?? null
      : hasContractGroup1
        ? null
        : defs.uniforms?.local ?? null;
    if (contractUniform && !localStruct) {
      throw new Error(
        `RenderPass: shader.contract에서 지정한 uniform('${uniformVarName}')를 찾을 수 없습니다.`
      );
    }
    if (localStruct) {
      this.uniforms = new UniformBlock({
        device: this.device,
        structDef: localStruct,
      });
    }
    const hasLocalResources = hasContractGroup1
      ? Boolean(
        (contractGroup1.uniform ||
          (Array.isArray(contractGroup1.textures) &&
            contractGroup1.textures.length > 0))
      )
      : Boolean(localStruct) || this.textures.length > 0;
    if (hasLocalResources) {
      this._updateLocalBindGroup();
      if (this.localBindGroupLayout) {
        bindGroupLayouts.push(this.localBindGroupLayout);
      }
    }

    //파이프라인 레이아웃 구축
    this.pipelineLayout = this.device.createPipelineLayout({
      label: "RenderPass.PipelineLayout",
      bindGroupLayouts,
    });
    this._ensurePipeline();
    // 로컬 uniform pending flush
    if (this.uniforms) {
      if (Object.keys(this.pendingUniforms).length > 0) {
        this.uniforms.set(this.pendingUniforms);
        this.pendingUniforms = {};
      }
    } else if (Object.keys(this.pendingUniforms).length > 0) {
      if (!this._warnedNoLocalUniform) {
        console.warn(
          `[${this.label}] local uniform이 없어 setUniforms 호출을 무시합니다.`
        );
        this._warnedNoLocalUniform = true;
      }
      this.pendingUniforms = {};
    }

    this.isInitialized = true;
  }

  encode(commandEncoder, screenView) {
    if (!this.geometry) return;

    this._syncLocalBindGroup();
    this._ensurePipeline();
    if (!this.pipeline) return;

    const targetView = this._resolveTargetView(screenView);
    const encoder = commandEncoder;
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: targetView,
          clearValue: this.clearColor,
          loadOp: this.clearMode,
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(this.pipeline);
    //유니폼버퍼 바인딩
    if (this.globalUniforms) {
      this.globalUniforms.bind(pass);
    }
    if (this.uniforms) {
      this.uniforms.upload();
    }
    if (this.localBindGroup) {
      pass.setBindGroup(1, this.localBindGroup);
    }
    //정점버퍼 바인딩 & draw
    this.geometry.bind(pass);
    this.geometry.draw(pass);
    pass.end();
  }

  _resolveTargetResource() {
    if (!this.target) return null;
    if (typeof this.target === "string") {
      return this.renderer?.getTexture?.(this.target) ?? null;
    }
    return this.target;
  }

  _resolveTargetView(screenView) {
    const target = this._resolveTargetResource();
    if (!target) return screenView;
    return target.getTextureView?.() ?? target.view ?? screenView;
  }

  _getTargetFormat() {
    const target = this._resolveTargetResource();
    return target?.format ?? this.format ?? null;
  }

  _createPipelineForFormat(format) {
    if (!format) {
      throw new Error(`[${this.label}] render target format을 결정할 수 없습니다.`);
    }
    if (!this.pipelineLayout || !this.shaderModule) {
      throw new Error(`[${this.label}] pipeline 생성에 필요한 초기화가 완료되지 않았습니다.`);
    }

    return this.device.createRenderPipeline({
      label: `${this.label}.pipeline.${format}`,
      layout: this.pipelineLayout,
      vertex: {
        module: this.shaderModule,
        entryPoint: "vertexMain",
        buffers: this.geometry?.getVBL(),
      },
      fragment: {
        module: this.shaderModule,
        entryPoint: "fragmentMain",
        targets: [{ format }],
      },
      primitive: { topology: this.geometry?.topology ?? "triangle-list" },
    });
  }

  _ensurePipeline() {
    const format = this._getTargetFormat();
    if (!format || !this.device || !this.geometry) return;

    if (this.pipelineFormat === format && this.pipeline) return;

    const cached = this.pipelineCache.get(format);
    if (cached) {
      this.pipeline = cached;
      this.pipelineFormat = format;
      return;
    }

    const pipeline = this._createPipelineForFormat(format);
    this.pipelineCache.set(format, pipeline);
    this.pipeline = pipeline;
    this.pipelineFormat = format;
  }

  _getLocalBindingPlan() {
    const group1 = this.shaderContract?.group1;
    if (group1 && typeof group1 === "object") {
      const hasLocalUniform = Boolean(group1.uniform);
      const fallbackBase = hasLocalUniform ? 1 : 0;
      const uniformBinding = hasLocalUniform
        ? Number.isInteger(group1.uniform.binding)
          ? group1.uniform.binding
          : 0
        : null;

      const specs = Array.isArray(group1.textures) ? group1.textures : [];
      const textures = specs.map((spec, slot) => {
        const textureBinding = Number.isInteger(spec.textureBinding)
          ? spec.textureBinding
          : fallbackBase + slot * 2;
        const samplerBinding = Number.isInteger(spec.samplerBinding)
          ? spec.samplerBinding
          : textureBinding + 1;
        const resource = this._resolveContractTextureResource(spec, slot);

        const sampleType = spec.sampleType ?? "float";
        return {
          slot,
          name: spec.name ?? `texture${slot}`,
          textureBinding,
          samplerBinding,
          sampleType,
          viewDimension: spec.viewDimension ?? "2d",
          multisampled: Boolean(spec.multisampled),
          samplerType:
            spec.samplerType ?? (sampleType === "float" ? "filtering" : "non-filtering"),
          resource,
        };
      });

      const plan = {
        source: "contract",
        hasLocalUniform,
        uniformBinding,
        uniformVisibility:
          group1.uniform?.visibility ??
          (GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT),
        textures,
      };

      plan.hasAnyLocalResource = hasLocalUniform || textures.length > 0;
      plan.layoutKey = JSON.stringify({
        source: plan.source,
        u: [plan.hasLocalUniform, plan.uniformBinding, plan.uniformVisibility],
        t: textures.map((x) => [
          x.textureBinding,
          x.samplerBinding,
          x.sampleType,
          x.viewDimension,
          x.multisampled,
          x.samplerType,
        ]),
      });

      return plan;
    }

    //로컬 유니폼 여부에 따라 바인딩 슬롯을 할당
    const hasLocalUniform = Boolean(this.uniforms);
    const textureCount = this.textures.length;
    const plan = {
      source: "fallback",
      hasLocalUniform,
      uniformBinding: hasLocalUniform ? 0 : null,
      textureBaseBinding: hasLocalUniform ? 1 : 0,
      uniformVisibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
      textures: [],
    };
    for (let slot = 0; slot < textureCount; slot++) {
      const resource = this.textures[slot];
      if (!resource) {
        throw new Error(`[${this.label}] textures[${slot}]가 비어 있습니다.`);
      }
      const textureBinding = plan.textureBaseBinding + slot * 2;
      plan.textures.push({
        slot,
        textureBinding,
        samplerBinding: textureBinding + 1,
        sampleType: "float",
        viewDimension: "2d",
        multisampled: false,
        samplerType: "filtering",
        resource,
      });
    }
    plan.hasAnyLocalResource = plan.hasLocalUniform || plan.textures.length > 0;
    plan.layoutKey = JSON.stringify({
      source: plan.source,
      u: [plan.hasLocalUniform, plan.uniformBinding, plan.uniformVisibility],
      t: plan.textures.map((x) => [
        x.textureBinding,
        x.samplerBinding,
        x.sampleType,
        x.viewDimension,
        x.multisampled,
        x.samplerType,
      ]),
    });

    return plan;
  }

  _resolveContractTextureResource(spec, slot) {
    const bySlot = this.textures[slot] ?? null;
    if (bySlot) return bySlot;

    const textureName = spec.name || spec.varName || `slot ${slot}`;
    const byName = this.renderer?.getTexture?.(textureName) ?? null;
    if (byName) return byName;

    throw new Error(
      `[${this.label}] shader.contract 텍스처 '${textureName}'를 찾을 수 없습니다. ` +
        `renderer.createTexture('${textureName}', ...)를 addPass 전에 호출하거나 pass.textures[${slot}]를 직접 설정하세요.`
    );
  }

  _getTextureBindingKey(resource) {
    if (!resource) return "missing";
    if (typeof resource.getBindingKey === "function") {
      return resource.getBindingKey();
    }
    return [
      getResourceIdentity(resource),
      getResourceIdentity(resource.getTextureView?.() ?? resource.view ?? null),
      getResourceIdentity(resource.getSampler?.() ?? resource.sampler ?? null),
    ]
      .join(":");
  }

  _buildLocalResourceKey(plan) {
    if (!plan.hasAnyLocalResource) return null;
    return plan.textures
      .map((texture) => `${texture.slot}:${this._getTextureBindingKey(texture.resource)}`)
      .join("|");
  }

  _syncLocalBindGroup() {
    const group1 = this.shaderContract?.group1;
    const shouldCheck =
      Boolean(this.uniforms) ||
      this.textures.length > 0 ||
      Boolean(group1?.uniform) ||
      (Array.isArray(group1?.textures) && group1.textures.length > 0) ||
      Boolean(this.localBindGroup);

    if (!shouldCheck) return;

    const plan = this._getLocalBindingPlan();
    const nextResourceKey = this._buildLocalResourceKey(plan);
    const needsRefresh =
      this._localLayoutKey !== plan.layoutKey ||
      this._localResourceKey !== nextResourceKey ||
      (!this.localBindGroup && plan.hasAnyLocalResource);

    if (!needsRefresh) return;

    this._updateLocalBindGroup(plan, nextResourceKey);
  }

  _updateLocalBindGroup(plan = this._getLocalBindingPlan(), resourceKey = null) {
    //로컬 리소스가 없다면
    if (!plan.hasAnyLocalResource) {
      this.localBindGroupLayout = null;
      this.localBindGroup = null;
      this.localBindingPlan = null;
      this._localLayoutKey = null;
      this._localResourceKey = null;
      return;
    }
    const layoutEntries = [];
    const bindEntries = [];
    //로컬 유니폼이 있다면 레이아웃을 만들고 layoutEntries에 삽입,
    //그리고 bindEntries에도
    if (plan.hasLocalUniform) {
      layoutEntries.push({
        binding: plan.uniformBinding,
        visibility: plan.uniformVisibility,
        buffer: {},
      });
      bindEntries.push({
        binding: plan.uniformBinding,
        resource: { buffer: this.uniforms.buffer },
      });
    }
    //텍스처
    for (const t of plan.textures) {
      layoutEntries.push({
        binding: t.textureBinding,
        visibility: GPUShaderStage.FRAGMENT,
        texture: {
          sampleType: t.sampleType,
          viewDimension: t.viewDimension,
          multisampled: t.multisampled,
        },
      });
      layoutEntries.push({
        binding: t.samplerBinding,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: t.samplerType },
      });

      bindEntries.push({
        binding: t.textureBinding,
        resource: t.resource.getTextureView(),
      });
      bindEntries.push({
        binding: t.samplerBinding,
        resource: t.resource.getSampler(),
      });
    }

    layoutEntries.sort((a, b) => a.binding - b.binding);
    bindEntries.sort((a, b) => a.binding - b.binding);

    if (this._localLayoutKey !== plan.layoutKey) {
      this.localBindGroupLayout = this.device.createBindGroupLayout({
        label: `${this.label}.localBGL`,
        entries: layoutEntries,
      });
      this._localLayoutKey = plan.layoutKey;
    }

    this.localBindGroup = this.device.createBindGroup({
      label: `${this.label}.localBG`,
      layout: this.localBindGroupLayout,
      entries: bindEntries,
    });

    this.localBindingPlan = plan;
    this._localResourceKey = resourceKey ?? this._buildLocalResourceKey(plan);
  }

  setUniforms(values = {}) {
    if (!this.isInitialized) {
      Object.assign(this.pendingUniforms, values);
      return;
    }

    if (!this.uniforms) {
      if (!this._warnedNoLocalUniform) {
        console.warn(
          `[${this.label}] local uniform이 없어 setUniforms 호출을 무시합니다.`
        );
        this._warnedNoLocalUniform = true;
      }
      return;
    }
    this.uniforms.set(values);
  }

  setTarget(target) {
    this.target = target;
    if (!this.isInitialized) return;
    this._ensurePipeline();
    this.onResize(this.renderer ? { renderer: this.renderer } : null);
  }

  onResize(ctx) {
    if (ctx?.renderer) {
      this.renderer = ctx.renderer;
    }
    if (!this.isInitialized) return;
    if (!this.localBindGroupLayout && !this.localBindGroup) return;
    this._updateLocalBindGroup();
  }

  destroy() {
    this.uniforms?.destroy?.();
    this.uniforms = null;
    if (this.ownsGeometry) {
      this.geometry?.destroy?.();
    }
    this.geometry = null;
    this.ownsGeometry = false;
    this.pipeline = null;
    this.pipelineFormat = null;
    this.pipelineCache.clear();
    this.pipelineLayout = null;
    this.shaderModule = null;
    this.globalUniforms = null;
    this.renderer = null;
    this.device = null;
    this.format = null;
    this.canvas = null;
    this.target = null;
    this.shader = null;
    this.shaderCode = null;
    this.shaderContract = null;
    this.pendingUniforms = {};
    this.localBindGroupLayout = null;
    this.localBindGroup = null;
    this.localBindingPlan = null;
    this._localLayoutKey = null;
    this._localResourceKey = null;
    this.isInitialized = false;
    this._warnedNoLocalUniform = false;
  }
}
