import {
  getSizeAndAlignmentOfUnsizedArrayElement,
  makeShaderDataDefinitions,
} from "webgpu-utils";
import { UniformBlock } from "@/webgpu/engine/uniforms/UniformBlock";
import { Geometry } from "@/webgpu/engine/Geometry";
import { StorageBlock } from "@/webgpu/engine/uniforms/StorageBlock";

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

function isStorageBlockLike(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.getLayoutEntry === "function" &&
      typeof value.getBindResource === "function"
  );
}

function isGpuBufferLike(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.destroy === "function" &&
      typeof value.size === "number"
  );
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStorageBindingSpecLike(value) {
  if (!isPlainObject(value)) return false;

  return Boolean(
    value.block ||
      value.buffer ||
      value.resource ||
      Number.isInteger(value.binding) ||
      typeof value.upload === "function" ||
      value.bindingKey != null ||
      value.visibility != null ||
      value.bufferType != null
  );
}

function normalizeStorageCollectionInput(storages) {
  if (storages == null) return [];
  if (Array.isArray(storages)) return storages;
  if (
    isStorageBlockLike(storages) ||
    isGpuBufferLike(storages) ||
    isStorageBindingSpecLike(storages)
  ) {
    return [storages];
  }
  if (isPlainObject(storages)) {
    return { ...storages };
  }
  return [storages];
}

function getStorageBlockInstance(value) {
  if (isStorageBlockLike(value?.block)) return value.block;
  if (isStorageBlockLike(value)) return value;
  return null;
}

function cloneArrayBufferView(value) {
  if (value instanceof ArrayBuffer) {
    return value.slice(0);
  }
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }
  return value ?? null;
}

function cloneStorageCreationOptions(options = {}) {
  const next = { ...options };
  const arrayBuffer = cloneArrayBufferView(options.arrayBuffer);
  const initialData = cloneArrayBufferView(options.initialData);

  next.arrayBuffer = arrayBuffer instanceof ArrayBuffer ? arrayBuffer : null;
  next.initialData = initialData ?? null;
  return next;
}

class DeferredStorageBlock {
  constructor({
    name,
    label = "DeferredStorageBlock",
    pendingOptions = {},
  } = {}) {
    this.name = name ?? label;
    this.label = label;
    this.block = null;
    this.pendingOptions = cloneStorageCreationOptions(pendingOptions);
    this.destroyed = false;
  }

  configure(options = {}) {
    if (this.destroyed) return this;
    this.pendingOptions = cloneStorageCreationOptions(options);
    return this;
  }

  getPendingOptions() {
    return cloneStorageCreationOptions(this.pendingOptions);
  }

  resolve(block) {
    if (this.destroyed) {
      block?.destroy?.();
      return null;
    }

    this.block = block;
    return this.block;
  }

  getLayoutEntry() {
    if (!this.block) {
      throw new Error(
        `DeferredStorageBlock('${this.name}')는 아직 초기화되지 않았습니다. renderer.addPass(pass) 이후 사용하세요.`
      );
    }
    return this.block.getLayoutEntry();
  }

  getBindResource() {
    if (!this.block) {
      throw new Error(
        `DeferredStorageBlock('${this.name}')는 아직 초기화되지 않았습니다. renderer.addPass(pass) 이후 사용하세요.`
      );
    }
    return this.block.getBindResource();
  }

  getBindingKey() {
    return this.block?.getBindingKey?.() ?? `pending:${this.name}`;
  }

  set(values) {
    if (this.block) {
      this.block.set(values);
      return;
    }
    this.pendingOptions = {
      ...this.pendingOptions,
      initialValues: values,
      initialData: null,
      arrayBuffer: null,
    };
  }

  setData(data) {
    if (this.block) {
      this.block.setData(data);
      return;
    }

    this.pendingOptions = {
      ...this.pendingOptions,
      initialValues: null,
      initialData: cloneArrayBufferView(data) ?? data,
      arrayBuffer: null,
    };
  }

  resize(byteLength, options = {}) {
    if (this.block) {
      return this.block.resize(byteLength, options);
    }

    const nextSize = Math.floor(byteLength);
    if (!Number.isFinite(nextSize) || nextSize <= 0) {
      throw new Error("DeferredStorageBlock.resize: byteLength는 0보다 커야 합니다.");
    }

    this.pendingOptions = {
      ...this.pendingOptions,
      byteLength: nextSize,
    };
    return true;
  }

  upload(force = false) {
    this.block?.upload?.(force);
  }

  destroy() {
    if (this.destroyed) return;
    this.block?.destroy?.();
    this.block = null;
    this.destroyed = true;
  }

  get binding() {
    return this.block?.binding ?? null;
  }

  get buffer() {
    return this.block?.buffer ?? null;
  }

  get view() {
    return this.block?.view ?? null;
  }

  get arrayBuffer() {
    return this.block?.arrayBuffer ?? null;
  }
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
    storages = [],
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
    this.storages = normalizeStorageCollectionInput(storages);
    this.shaderDataDefinitions = null;
    this.ownedStorageBlocks = new Set();
    this.pendingStorageCreations = new Map();
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
    // 로컬 리소스 (uniform + textures)
    const defs = makeShaderDataDefinitions(this.shaderCode);
    this.shaderDataDefinitions = defs;
    this._realizePendingStorageCreations();
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
            contractGroup1.textures.length > 0) ||
          (Array.isArray(contractGroup1.storages) &&
            contractGroup1.storages.length > 0) ||
          this._hasAnyStorageInput())
      )
      : Boolean(localStruct) ||
        this.textures.length > 0 ||
        this._hasAnyStorageInput();
    if (hasLocalResources) {
      this._updateLocalBindGroup();
    }

    //파이프라인 레이아웃 구축
    this._rebuildPipelineLayout();
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
    this._uploadStorages();
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

  _rebuildPipelineLayout(bindGroupLayouts = null) {
    const layouts =
      bindGroupLayouts ??
      (() => {
        const globalLayout = this.globalUniforms?.getBindGroupLayout?.();
        if (!globalLayout) {
          throw new Error("RenderPass: global bindGroupLayout을 찾을 수 없습니다.");
        }

        const nextLayouts = [globalLayout];
        if (this.localBindGroupLayout) {
          nextLayouts.push(this.localBindGroupLayout);
        }
        return nextLayouts;
      })();

    this.pipelineLayout = this.device.createPipelineLayout({
      label: "RenderPass.PipelineLayout",
      bindGroupLayouts: layouts,
    });
    this.pipeline = null;
    this.pipelineFormat = null;
    this.pipelineCache.clear();
  }

  _getStorageEntries(collection = this.storages) {
    if (Array.isArray(collection)) {
      return collection.map((value, slot) => ({
        key: null,
        slot,
        value,
      }));
    }
    if (!isPlainObject(collection)) return [];

    return Object.entries(collection).map(([key, value], slot) => ({
      key,
      slot,
      value,
    }));
  }

  _hasAnyStorageInput(collection = this.storages) {
    return this._getStorageEntries(collection).length > 0;
  }

  _matchesStorageName(value, name, key = null) {
    if (!name) return false;
    if (key === name) return true;
    if (!value || typeof value !== "object") return false;
    if (value.name === name) return true;
    if (value.storageName === name) return true;
    if (value.label === name) return true;

    const block = getStorageBlockInstance(value);
    if (!block) return false;
    if (block.name === name) return true;
    if (block.label === name) return true;
    return false;
  }

  _findStorageEntryByName(name, collection = this.storages) {
    return (
      this._getStorageEntries(collection).find((entry) =>
        this._matchesStorageName(entry.value, name, entry.key)
      ) ?? null
    );
  }

  _findStorageEntryBySlot(slot, collection = this.storages) {
    return this._getStorageEntries(collection)[slot] ?? null;
  }

  _getStorageValueByName(name, collection = this.storages) {
    return this._findStorageEntryByName(name, collection)?.value ?? null;
  }

  _cloneStorageCollectionAsNamedMap(collection = this.storages) {
    const next = {};
    for (const { key, slot, value } of this._getStorageEntries(collection)) {
      const block = getStorageBlockInstance(value);
      const fallbackKey =
        key ??
        value?.name ??
        value?.storageName ??
        block?.name ??
        block?.label ??
        `slot${slot}`;
      next[fallbackKey] = value;
    }
    return next;
  }

  _toNamedStorageBindingSpec(value, key = null) {
    if (key == null || value == null) return value;
    if (isStorageBlockLike(value)) {
      return {
        name: key,
        storageName: key,
        block: value,
      };
    }
    if (isGpuBufferLike(value)) {
      return {
        name: key,
        storageName: key,
        buffer: value,
      };
    }
    if (!isPlainObject(value)) return value;

    return {
      ...value,
      name: value.name ?? key,
      storageName: value.storageName ?? key,
    };
  }

  _collectStorageBlocks(collection = this.storages) {
    const blocks = new Set();
    for (const { value } of this._getStorageEntries(collection)) {
      const block = getStorageBlockInstance(value);
      if (block) {
        blocks.add(block);
      }
    }
    return blocks;
  }

  _disposeOwnedStorageBlocksRemovedBy(nextCollection) {
    const nextBlocks = this._collectStorageBlocks(nextCollection);
    for (const block of this._collectStorageBlocks(this.storages)) {
      if (!this.ownedStorageBlocks.has(block)) continue;
      if (nextBlocks.has(block)) continue;
      block.destroy?.();
      this.ownedStorageBlocks.delete(block);
    }
  }

  _disposePendingStorageCreationsRemovedBy(nextCollection) {
    if (this.pendingStorageCreations.size === 0) return;

    const currentEntries = this._getStorageEntries(this.storages);
    const nextEntries = this._getStorageEntries(nextCollection);
    for (const [name, handle] of this.pendingStorageCreations.entries()) {
      const wasReferenced = currentEntries.some(
        ({ key, value }) =>
          value === handle || this._matchesStorageName(value, name, key)
      );
      if (!wasReferenced) continue;

      const keep = nextEntries.some(
        ({ key, value }) =>
          value === handle || this._matchesStorageName(value, name, key)
      );
      if (keep) continue;
      handle.destroy?.();
      this.pendingStorageCreations.delete(name);
    }
  }

  _getLocalBindingPlan() {
    const group1 = this.shaderContract?.group1;
    if (group1 && typeof group1 === "object") {
      const storages = this._getStorageBindingPlan(group1.storages);
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
        storages,
      };

      plan.hasAnyLocalResource =
        hasLocalUniform || textures.length > 0 || storages.length > 0;
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
        s: storages.map((x) => [
          x.binding,
          x.visibility,
          x.bufferType,
        ]),
      });

      this._validateLocalBindingPlan(plan);
      return plan;
    }

    //로컬 유니폼 여부에 따라 바인딩 슬롯을 할당
    const hasLocalUniform = Boolean(this.uniforms);
    const textureCount = this.textures.length;
    const storages = this._getStorageBindingPlan();
    const plan = {
      source: "fallback",
      hasLocalUniform,
      uniformBinding: hasLocalUniform ? 0 : null,
      textureBaseBinding: hasLocalUniform ? 1 : 0,
      uniformVisibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
      textures: [],
      storages,
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
    plan.hasAnyLocalResource =
      plan.hasLocalUniform ||
      plan.textures.length > 0 ||
      plan.storages.length > 0;
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
      s: plan.storages.map((x) => [x.binding, x.visibility, x.bufferType]),
    });

    this._validateLocalBindingPlan(plan);
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

  _getStorageBindingPlan(contractSpecs = null) {
    if (Array.isArray(contractSpecs) && contractSpecs.length > 0) {
      return contractSpecs.map((spec, slot) =>
        this._normalizeContractStorageBinding(spec, slot)
      );
    }

    const entries = this._getStorageEntries();
    if (entries.length === 0) {
      return [];
    }

    return entries.map(({ key, value, slot }) =>
      this._normalizeStorageBinding(this._toNamedStorageBindingSpec(value, key), slot)
    );
  }

  _normalizeContractStorageBinding(spec, slot) {
    const resolved = this._resolveContractStorageResource(spec, slot);
    const block = resolved?.block ?? (isStorageBlockLike(resolved) ? resolved : null);

    if (block) {
      const resource = block.getBindResource();
      if (!resource?.buffer) {
        throw new Error(
          `[${this.label}] storage '${spec.name ?? spec.varName ?? slot}'의 buffer를 확인할 수 없습니다.`
        );
      }

      return {
        slot,
        name: spec.name ?? `storage${slot}`,
        varName: spec.varName ?? spec.as ?? spec.name ?? `storage${slot}`,
        binding: spec.binding,
        visibility:
          spec.visibility ?? (GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT),
        bufferType: spec.bufferType ?? "read-only-storage",
        resource,
        bindingKey:
          typeof block.getBindingKey === "function"
            ? block.getBindingKey()
            : this._getStorageBindingKey(resource),
        uploader: typeof block.upload === "function" ? block : null,
      };
    }

    const normalized = this._normalizeStorageBinding(
      isGpuBufferLike(resolved)
        ? {
            buffer: resolved,
            binding: spec.binding,
            visibility:
              spec.visibility ?? (GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT),
            bufferType: spec.bufferType ?? "read-only-storage",
          }
        : {
            ...(isPlainObject(resolved) ? resolved : {}),
            binding: spec.binding,
            visibility:
              resolved?.visibility ??
              spec.visibility ??
              (GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT),
            bufferType:
              resolved?.bufferType ?? spec.bufferType ?? "read-only-storage",
          },
      slot
    );

    return {
      ...normalized,
      name: spec.name ?? `storage${slot}`,
      varName: spec.varName ?? spec.as ?? spec.name ?? `storage${slot}`,
      binding: spec.binding,
      visibility:
        normalized.visibility ??
        spec.visibility ??
        (GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT),
      bufferType: normalized.bufferType ?? spec.bufferType ?? "read-only-storage",
    };
  }

  _normalizeStorageBinding(spec, slot) {
    const block = spec?.block ?? (isStorageBlockLike(spec) ? spec : null);
    if (block) {
      const layoutEntry = block.getLayoutEntry();
      const resource = block.getBindResource();
      if (!layoutEntry || !resource?.buffer) {
        throw new Error(
          `[${this.label}] storages[${slot}] StorageBlock에서 binding/resource를 확인할 수 없습니다.`
        );
      }

      return {
        slot,
        binding: layoutEntry.binding,
        visibility:
          layoutEntry.visibility ??
          (GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT),
        bufferType: layoutEntry.buffer?.type ?? "read-only-storage",
        resource,
        bindingKey:
          typeof block.getBindingKey === "function"
            ? block.getBindingKey()
            : this._getStorageBindingKey(resource),
        uploader: typeof block.upload === "function" ? block : null,
      };
    }

    const rawBuffer = isGpuBufferLike(spec?.buffer)
      ? spec.buffer
      : isGpuBufferLike(spec)
        ? spec
        : null;
    const resource =
      spec?.resource?.buffer ? spec.resource : rawBuffer ? { buffer: rawBuffer } : null;

    if (!resource?.buffer) {
      throw new Error(
        `[${this.label}] storages[${slot}]는 StorageBlock 또는 { binding, resource: { buffer } } 형태여야 합니다.`
      );
    }
    if (!Number.isInteger(spec?.binding)) {
      throw new Error(`[${this.label}] storages[${slot}].binding이 필요합니다.`);
    }

    return {
      slot,
      binding: spec.binding,
      visibility:
        spec.visibility ?? (GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT),
      bufferType: spec.bufferType ?? "read-only-storage",
      resource,
      bindingKey: spec.bindingKey ?? this._getStorageBindingKey(resource),
      uploader: typeof spec?.upload === "function" ? spec : null,
    };
  }

  _getStorageBindingKey(resource) {
    const buffer = resource?.buffer ?? null;
    return [getResourceIdentity(buffer), buffer?.size ?? "0"].join(":");
  }

  _resolveContractStorageResource(spec, slot) {
    const storageName = spec.name || spec.varName || `slot ${slot}`;
    const byName = this._findStorageResourceByName(storageName);
    if (byName) return byName;

    const bySlot = this._findStorageEntryBySlot(slot)?.value ?? null;
    if (bySlot) return bySlot;

    throw new Error(
      `[${this.label}] shader.contract storage '${storageName}'를 찾을 수 없습니다. ` +
        `pass.setStorage('${storageName}', storage) 또는 pass.setStorages({ ${storageName}: storage })로 연결하세요.`
    );
  }

  _findStorageResourceByName(name) {
    return this._getStorageValueByName(name);
  }

  _buildLocalResourceKey(plan) {
    if (!plan.hasAnyLocalResource) return null;
    const textureKey = plan.textures
      .map(
        (texture) => `${texture.slot}:${this._getTextureBindingKey(texture.resource)}`
      )
      .join("|");
    const storageKey = plan.storages
      .map((storage) => `${storage.slot}:${storage.binding}:${storage.bindingKey}`)
      .join("|");

    return [textureKey, storageKey].filter(Boolean).join("||");
  }

  _syncLocalBindGroup() {
    const group1 = this.shaderContract?.group1;
    const shouldCheck =
      Boolean(this.uniforms) ||
      this.textures.length > 0 ||
      this._hasAnyStorageInput() ||
      Boolean(group1?.uniform) ||
      (Array.isArray(group1?.textures) && group1.textures.length > 0) ||
      (Array.isArray(group1?.storages) && group1.storages.length > 0) ||
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
      const hadLocalLayout = Boolean(this.localBindGroupLayout);
      this.localBindGroupLayout = null;
      this.localBindGroup = null;
      this.localBindingPlan = null;
      this._localLayoutKey = null;
      this._localResourceKey = null;
      if (hadLocalLayout && this.isInitialized) {
        this._rebuildPipelineLayout();
      }
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
    for (const s of plan.storages) {
      layoutEntries.push({
        binding: s.binding,
        visibility: s.visibility,
        buffer: {
          type: s.bufferType,
        },
      });
      bindEntries.push({
        binding: s.binding,
        resource: s.resource,
      });
    }

    layoutEntries.sort((a, b) => a.binding - b.binding);
    bindEntries.sort((a, b) => a.binding - b.binding);

    const layoutChanged = this._localLayoutKey !== plan.layoutKey;
    if (layoutChanged) {
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

    if (layoutChanged && this.isInitialized) {
      this._rebuildPipelineLayout();
    }
  }

  _uploadStorages() {
    for (const storage of this.localBindingPlan?.storages ?? []) {
      storage.uploader?.upload?.();
    }
  }

  _validateLocalBindingPlan(plan) {
    const bindings = new Map();
    const pushBinding = (binding, label) => {
      if (!Number.isInteger(binding)) return;
      if (bindings.has(binding)) {
        throw new Error(
          `[${this.label}] local binding 충돌: binding(${binding})에 '${bindings.get(binding)}'와 '${label}'가 동시에 할당되었습니다.`
        );
      }
      bindings.set(binding, label);
    };

    if (plan.hasLocalUniform) {
      pushBinding(plan.uniformBinding, "local uniform");
    }
    for (const texture of plan.textures) {
      pushBinding(texture.textureBinding, `texture:${texture.name}`);
      pushBinding(texture.samplerBinding, `sampler:${texture.name}`);
    }
    for (const storage of plan.storages) {
      pushBinding(storage.binding, `storage:${storage.slot}`);
    }
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

  _getContractStorageSpec(name) {
    const specs = this.shaderContract?.group1?.storages;
    if (!Array.isArray(specs)) return null;
    return (
      specs.find((spec) => spec?.name === name || spec?.varName === name) ?? null
    );
  }

  _getStorageCreationConfig(name) {
    const contractSpec = this._getContractStorageSpec(name);
    const definitionName = contractSpec?.varName ?? name;
    const definition =
      this.shaderDataDefinitions?.storages?.[definitionName] ??
      this.shaderDataDefinitions?.storages?.[name] ??
      null;

    if (!definition) return null;

    return {
      name: contractSpec?.name ?? name,
      varName: definitionName,
      binding: contractSpec?.binding ?? definition.binding,
      visibility:
        contractSpec?.visibility ??
        (GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT),
      bufferType: contractSpec?.bufferType ?? "read-only-storage",
      definition,
    };
  }

  _inferStorageElementCount(definition, initialValues) {
    const typeDefinition = definition?.typeDefinition ?? null;
    if (
      typeDefinition &&
      typeof typeDefinition === "object" &&
      "elementType" in typeDefinition &&
      typeDefinition.numElements === 0 &&
      Array.isArray(initialValues)
    ) {
      return initialValues.length;
    }
    return null;
  }

  _resolveCreatedStorageByteLength(name, definition, options = {}) {
    if (Number.isFinite(options.byteLength)) {
      return Math.floor(options.byteLength);
    }

    if (options.arrayBuffer instanceof ArrayBuffer) {
      return null;
    }

    if (options.initialData instanceof ArrayBuffer) {
      return options.initialData.byteLength;
    }
    if (ArrayBuffer.isView(options.initialData)) {
      return options.initialData.byteLength;
    }

    const { size: elementSize } =
      getSizeAndAlignmentOfUnsizedArrayElement(definition);
    if (elementSize <= 0) {
      return null;
    }

    const inferredLength = Number.isFinite(options.length)
      ? Math.max(0, Math.floor(options.length))
      : this._inferStorageElementCount(definition, options.initialValues);

    if (inferredLength == null) {
      throw new Error(
        `[${this.label}] storage '${name}'는 가변 길이 storage여서 length 또는 byteLength(또는 initialData/arrayBuffer)가 필요합니다.`
      );
    }

    const totalByteLength = definition.size + elementSize * inferredLength;
    if (totalByteLength <= 0) {
      throw new Error(
        `[${this.label}] storage '${name}'의 byteLength를 0보다 크게 계산할 수 없습니다.`
      );
    }

    return totalByteLength;
  }

  _createStorageBlock(name, options = {}) {
    const config = this._getStorageCreationConfig(name);
    if (!config) {
      throw new Error(
        `[${this.label}] shader에서 storage '${name}' 정의를 찾을 수 없습니다.`
      );
    }

    const normalizedOptions = cloneStorageCreationOptions(options);
    return new StorageBlock({
      device: this.device,
      name,
      label: normalizedOptions.label ?? `${this.label}.${name}`,
      binding: config.binding,
      visibility: config.visibility,
      structDef: config.definition,
      initialValues: normalizedOptions.initialValues ?? null,
      initialData: normalizedOptions.initialData ?? null,
      arrayBuffer:
        normalizedOptions.arrayBuffer instanceof ArrayBuffer
          ? normalizedOptions.arrayBuffer
          : null,
      byteLength: this._resolveCreatedStorageByteLength(name, config.definition, {
        ...normalizedOptions,
        arrayBuffer:
          normalizedOptions.arrayBuffer instanceof ArrayBuffer
            ? normalizedOptions.arrayBuffer
            : null,
      }),
      bufferType: config.bufferType,
      usage: normalizedOptions.usage,
    });
  }

  _realizePendingStorageCreations() {
    if (!this.device || !this.shaderDataDefinitions) return;
    if (this.pendingStorageCreations.size === 0) return;

    for (const [name, handle] of this.pendingStorageCreations.entries()) {
      if (!handle || handle.destroyed || handle.block) continue;
      const block = this._createStorageBlock(name, handle.getPendingOptions());
      this.ownedStorageBlocks.add(block);
      handle.resolve(block);
    }

    this.pendingStorageCreations.clear();
  }

  createStorage(name, options = {}) {
    if (!name || typeof name !== "string") {
      throw new Error(`[${this.label}] createStorage(name): 이름 문자열이 필요합니다.`);
    }
    if (!this.device || !this.shaderDataDefinitions) {
      const existing = this.pendingStorageCreations.get(name);
      const handle =
        existing ??
        new DeferredStorageBlock({
          name,
          label: options.label ?? `${this.label}.${name}`,
          pendingOptions: options,
        });

      handle.configure({
        label: options.label ?? `${this.label}.${name}`,
        ...options,
      });
      this.pendingStorageCreations.set(name, handle);
      if (options.bind !== false) {
        this.setStorage(name, handle);
      }
      return handle;
    }

    const block = this._createStorageBlock(name, options);
    this.ownedStorageBlocks.add(block);
    if (options.bind !== false) {
      this.setStorage(name, block);
    }
    return block;
  }

  getStorage(name) {
    if (!name || typeof name !== "string") return null;
    return this._getStorageValueByName(name) ?? this.pendingStorageCreations.get(name) ?? null;
  }

  clearStorage(name) {
    if (!name || typeof name !== "string") {
      throw new Error(`[${this.label}] clearStorage(name): 이름 문자열이 필요합니다.`);
    }

    const entry = this._findStorageEntryByName(name);
    const pendingHandle = this.pendingStorageCreations.get(name) ?? null;
    if (!entry && !pendingHandle) return false;

    let nextStorages = this.storages;
    if (entry) {
      if (Array.isArray(this.storages)) {
        nextStorages = [...this.storages];
        nextStorages.splice(entry.slot, 1);
      } else {
        nextStorages = { ...this.storages };
        delete nextStorages[entry.key];
      }
    }

    this._disposeOwnedStorageBlocksRemovedBy(nextStorages);
    if (pendingHandle) {
      pendingHandle.destroy?.();
      this.pendingStorageCreations.delete(name);
    }
    this.storages = nextStorages;

    if (this.isInitialized) {
      this._updateLocalBindGroup();
    }

    return true;
  }

  setStorage(name, storage) {
    if (!name || typeof name !== "string") {
      throw new Error(`[${this.label}] setStorage(name, storage): 이름 문자열이 필요합니다.`);
    }
    if (storage == null) {
      this.clearStorage(name);
      return;
    }

    const nextStorages = this._cloneStorageCollectionAsNamedMap();
    nextStorages[name] = storage;

    this._disposeOwnedStorageBlocksRemovedBy(nextStorages);
    if (storage !== this.pendingStorageCreations.get(name)) {
      this._disposePendingStorageCreationsRemovedBy(nextStorages);
    }
    this.storages = nextStorages;

    if (this.isInitialized) {
      this._updateLocalBindGroup();
    }
  }

  setStorages(storages = []) {
    const nextStorages = normalizeStorageCollectionInput(storages);
    this._disposeOwnedStorageBlocksRemovedBy(nextStorages);
    this._disposePendingStorageCreationsRemovedBy(nextStorages);
    this.storages = nextStorages;
    if (!this.isInitialized) return;
    this._updateLocalBindGroup();
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
    for (const block of this.ownedStorageBlocks) {
      block?.destroy?.();
    }
    this.ownedStorageBlocks.clear();
    for (const handle of this.pendingStorageCreations.values()) {
      handle?.destroy?.();
    }
    this.pendingStorageCreations.clear();
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
    this.shaderDataDefinitions = null;
    this.pendingUniforms = {};
    this.storages = [];
    this.localBindGroupLayout = null;
    this.localBindGroup = null;
    this.localBindingPlan = null;
    this._localLayoutKey = null;
    this._localResourceKey = null;
    this.isInitialized = false;
    this._warnedNoLocalUniform = false;
  }
}
