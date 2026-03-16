import { makeShaderDataDefinitions } from "webgpu-utils";
import { UniformBlock } from "./uniforms/UniformBlock";

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

function normalizeResourceCollectionInput(resources) {
  if (resources == null) return {};
  if (Array.isArray(resources)) {
    return resources.reduce((acc, resource, slot) => {
      acc[`slot${slot}`] = resource;
      return acc;
    }, {});
  }
  if (isPlainObject(resources)) {
    return { ...resources };
  }
  return { slot0: resources };
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

function normalizeResourceKey(nameOrSlot, label) {
  if (Number.isInteger(nameOrSlot) && nameOrSlot >= 0) {
    return `slot${nameOrSlot}`;
  }
  if (typeof nameOrSlot === "string" && nameOrSlot.trim()) {
    return nameOrSlot.trim();
  }
  throw new Error(`[${label}] resource key는 문자열 또는 0 이상의 정수여야 합니다.`);
}

function toStorageTextureLayoutAccess(access = "write") {
  if (access === "read") return "read-only";
  if (access === "read_write") return "read-write";
  return "write-only";
}

export class ComputePass {
  constructor({
    label = "Compute pass",
    shader = null,
    shaderCode = null,
    entryPoint = "computeMain",
    workgroups = [1, 1, 1],
    textures = {},
    storageTextures = {},
    storages = [],
  } = {}) {
    this.label = label;
    this.shader = shader;
    this.shaderCode = shader?.code ?? shaderCode;
    this.shaderContract = shader?.contract ?? null;
    this.entryPoint = shader?.contract?.entryPoint ?? entryPoint;
    this.workgroups = workgroups;
    this.defaultWorkgroupSize =
      Array.isArray(shader?.contract?.workgroupSize) &&
      shader.contract.workgroupSize.length > 0
        ? [
            shader.contract.workgroupSize[0],
            shader.contract.workgroupSize[1] ?? 1,
            shader.contract.workgroupSize[2] ?? 1,
          ]
        : null;

    this.textures = normalizeResourceCollectionInput(textures);
    this.storageTextures = normalizeResourceCollectionInput(storageTextures);
    this.storages = normalizeStorageCollectionInput(storages);

    this.device = null;
    this.renderer = null;
    this.globalUniforms = null;
    this.shaderModule = null;
    this.pipelineLayout = null;
    this.pipeline = null;

    this.uniforms = null;
    this.pendingUniforms = {};
    this.shaderDataDefinitions = null;

    this.localBindGroupLayout = null;
    this.localBindGroup = null;
    this.localBindingPlan = null;
    this._localLayoutKey = null;
    this._localResourceKey = null;
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
      if (typeof this.shader.contract?.entryPoint === "string") {
        this.entryPoint = this.shader.contract.entryPoint;
      }
    }

    if (!this.shaderCode) {
      throw new Error(`[${this.label}] 셰이더 코드가 필요합니다.`);
    }
    if (!this.entryPoint) {
      throw new Error(`[${this.label}] compute entryPoint가 필요합니다.`);
    }

    this.renderer = ctx.renderer;
    this.device = ctx.device;
    this.globalUniforms = ctx.globalUniforms;
    this.shaderModule = this.device.createShaderModule({
      label: `${this.label}.shader`,
      code: this.shaderCode,
    });

    const defs = makeShaderDataDefinitions(this.shaderCode);
    this.shaderDataDefinitions = defs;

    const contractGroup1 = this.shaderContract?.group1;
    const hasContractGroup1 = Boolean(
      contractGroup1 && typeof contractGroup1 === "object"
    );
    const contractUniform = contractGroup1?.uniform ?? null;
    const uniformVarName = contractUniform?.varName ?? "local";
    const localStruct = contractUniform
      ? defs.uniforms?.[uniformVarName] ?? null
      : hasContractGroup1
        ? null
        : defs.uniforms?.local ?? null;

    if (contractUniform && !localStruct) {
      throw new Error(
        `[${this.label}] shader.contract에서 지정한 uniform('${uniformVarName}')를 찾을 수 없습니다.`
      );
    }

    if (localStruct) {
      this.uniforms = new UniformBlock({
        device: this.device,
        label: `${this.label}.uniform`,
        visibility: GPUShaderStage.COMPUTE,
        structDef: localStruct,
      });
    }

    this._updateLocalBindGroup();
    this._rebuildPipelineLayout();
    this._ensurePipeline();

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

  _createPipeline() {
    if (!this.pipelineLayout || !this.shaderModule) {
      throw new Error(
        `[${this.label}] pipeline 생성에 필요한 초기화가 완료되지 않았습니다.`
      );
    }

    return this.device.createComputePipeline({
      label: `${this.label}.pipeline`,
      layout: this.pipelineLayout,
      compute: {
        module: this.shaderModule,
        entryPoint: this.entryPoint,
      },
    });
  }

  _ensurePipeline() {
    if (!this.device || !this.pipelineLayout || !this.shaderModule) return;
    if (this.pipeline) return;
    this.pipeline = this._createPipeline();
  }

  _rebuildPipelineLayout(bindGroupLayouts = null) {
    const layouts =
      bindGroupLayouts ??
      (() => {
        const globalLayout = this.globalUniforms?.getBindGroupLayout?.();
        if (!globalLayout) {
          throw new Error(
            `[${this.label}] global bindGroupLayout을 찾을 수 없습니다.`
          );
        }

        const nextLayouts = [globalLayout];
        if (this.localBindGroupLayout) {
          nextLayouts.push(this.localBindGroupLayout);
        }
        return nextLayouts;
      })();

    this.pipelineLayout = this.device.createPipelineLayout({
      label: `${this.label}.pipelineLayout`,
      bindGroupLayouts: layouts,
    });
    this.pipeline = null;
  }

  _resolveTextureByName(name) {
    if (!name) return null;
    return this.textures[name] ?? null;
  }

  _resolveTextureBySlot(slot) {
    return this.textures[`slot${slot}`] ?? null;
  }

  _resolveStorageTextureByName(name) {
    if (!name) return null;
    return this.storageTextures[name] ?? null;
  }

  _resolveStorageTextureBySlot(slot) {
    return this.storageTextures[`slot${slot}`] ?? null;
  }

  _resolveTextureResource(value) {
    if (typeof value === "string") {
      return this.renderer?.getTexture?.(value) ?? null;
    }
    return value ?? null;
  }

  _resolveContractTextureResource(spec, slot) {
    const byName = this._resolveTextureResource(this._resolveTextureByName(spec.name));
    if (byName) return byName;

    const byVarName = this._resolveTextureResource(
      this._resolveTextureByName(spec.varName)
    );
    if (byVarName) return byVarName;

    const bySlot = this._resolveTextureResource(this._resolveTextureBySlot(slot));
    if (bySlot) return bySlot;

    const fromRendererName = spec.name
      ? this.renderer?.getTexture?.(spec.name) ?? null
      : null;
    if (fromRendererName) return fromRendererName;

    const fromRendererVarName = spec.varName
      ? this.renderer?.getTexture?.(spec.varName) ?? null
      : null;
    if (fromRendererVarName) return fromRendererVarName;

    throw new Error(
      `[${this.label}] shader.contract 텍스처 '${spec.name ?? spec.varName ?? slot}'를 찾을 수 없습니다.`
    );
  }

  _resolveContractStorageTextureResource(spec, slot) {
    const byName = this._resolveTextureResource(
      this._resolveStorageTextureByName(spec.name)
    );
    if (byName) return byName;

    const byVarName = this._resolveTextureResource(
      this._resolveStorageTextureByName(spec.varName)
    );
    if (byVarName) return byVarName;

    const bySlot = this._resolveTextureResource(
      this._resolveStorageTextureBySlot(slot)
    );
    if (bySlot) return bySlot;

    const fromRendererName = spec.name
      ? this.renderer?.getTexture?.(spec.name) ?? null
      : null;
    if (fromRendererName) return fromRendererName;

    const fromRendererVarName = spec.varName
      ? this.renderer?.getTexture?.(spec.varName) ?? null
      : null;
    if (fromRendererVarName) return fromRendererVarName;

    throw new Error(
      `[${this.label}] shader.contract storage texture '${spec.name ?? spec.varName ?? slot}'를 찾을 수 없습니다.`
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
      .join(":")
      .trim();
  }

  _getStorageTextureBindingKey(resource) {
    if (!resource) return "missing";
    if (typeof resource.getBindingKey === "function") {
      return resource.getBindingKey();
    }
    return [
      getResourceIdentity(resource),
      getResourceIdentity(resource.getTextureView?.() ?? resource.view ?? null),
    ]
      .join(":")
      .trim();
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

    const block = isStorageBlockLike(value?.block)
      ? value.block
      : isStorageBlockLike(value)
        ? value
        : null;

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
      const block = isStorageBlockLike(value?.block)
        ? value.block
        : isStorageBlockLike(value)
          ? value
          : null;
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

  _getStorageBindingKey(resource) {
    const buffer = resource?.buffer ?? null;
    return [getResourceIdentity(buffer), buffer?.size ?? "0"].join(":");
  }

  _resolveContractStorageResource(spec, slot) {
    const storageName = spec.name || spec.varName || `slot${slot}`;
    const byName = this._getStorageValueByName(storageName);
    if (byName) return byName;

    const byVarName =
      storageName !== spec.varName ? this._getStorageValueByName(spec.varName) : null;
    if (byVarName) return byVarName;

    const bySlot = this._findStorageEntryBySlot(slot)?.value ?? null;
    if (bySlot) return bySlot;

    throw new Error(
      `[${this.label}] shader.contract storage '${storageName}'를 찾을 수 없습니다.`
    );
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
        visibility: layoutEntry.visibility ?? GPUShaderStage.COMPUTE,
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
      visibility: spec.visibility ?? GPUShaderStage.COMPUTE,
      bufferType: spec.bufferType ?? "read-only-storage",
      resource,
      bindingKey: spec.bindingKey ?? this._getStorageBindingKey(resource),
      uploader: typeof spec?.upload === "function" ? spec : null,
    };
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
        visibility: spec.visibility ?? GPUShaderStage.COMPUTE,
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
            visibility: spec.visibility ?? GPUShaderStage.COMPUTE,
            bufferType: spec.bufferType ?? "read-only-storage",
          }
        : {
            ...(isPlainObject(resolved) ? resolved : {}),
            binding: spec.binding,
            visibility: resolved?.visibility ?? spec.visibility ?? GPUShaderStage.COMPUTE,
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
      visibility: normalized.visibility ?? spec.visibility ?? GPUShaderStage.COMPUTE,
      bufferType: normalized.bufferType ?? spec.bufferType ?? "read-only-storage",
    };
  }

  _getStorageBindingPlan(contractSpecs = null) {
    if (Array.isArray(contractSpecs)) {
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

  _getLocalBindingPlan() {
    const group1 = this.shaderContract?.group1;
    if (group1 && typeof group1 === "object") {
      const hasLocalUniform = Boolean(group1.uniform);
      if (hasLocalUniform && !this.uniforms) {
        throw new Error(
          `[${this.label}] shader.contract.group1.uniform이 선언됐지만 local uniform을 생성할 수 없습니다.`
        );
      }

      const textures = (Array.isArray(group1.textures) ? group1.textures : []).map(
        (spec, slot) => {
          const resource = this._resolveContractTextureResource(spec, slot);
          if (
            typeof resource?.getTextureView !== "function" ||
            typeof resource?.getSampler !== "function"
          ) {
            throw new Error(
              `[${this.label}] texture '${spec.name ?? spec.varName ?? slot}'는 TextureResource 형태여야 합니다.`
            );
          }
          return {
            slot,
            name: spec.name ?? `texture${slot}`,
            varName: spec.varName ?? spec.as ?? spec.name ?? `texture${slot}`,
            textureBinding: spec.textureBinding,
            samplerBinding: spec.samplerBinding,
            sampleType: spec.sampleType ?? "float",
            viewDimension: spec.viewDimension ?? "2d",
            multisampled: Boolean(spec.multisampled),
            samplerType:
              spec.samplerType ??
              (spec.sampleType === "float" ? "filtering" : "non-filtering"),
            resource,
          };
        }
      );

      const storageTextures = (
        Array.isArray(group1.storageTextures) ? group1.storageTextures : []
      ).map((spec, slot) => {
        const resource = this._resolveContractStorageTextureResource(spec, slot);
        if (typeof resource?.getTextureView !== "function") {
          throw new Error(
            `[${this.label}] storage texture '${spec.name ?? spec.varName ?? slot}'는 TextureResource 형태여야 합니다.`
          );
        }

        return {
          slot,
          name: spec.name ?? `storageTexture${slot}`,
          varName:
            spec.varName ?? spec.as ?? spec.name ?? `storageTexture${slot}`,
          binding: spec.binding,
          access: spec.access ?? "write",
          format: spec.format ?? "rgba8unorm",
          viewDimension: spec.viewDimension ?? "2d",
          resource,
        };
      });

      const storages = this._getStorageBindingPlan(group1.storages);
      const uniformBinding = hasLocalUniform
        ? Number.isInteger(group1.uniform?.binding)
          ? group1.uniform.binding
          : 0
        : null;

      const plan = {
        source: "contract",
        hasLocalUniform,
        uniformBinding,
        uniformVisibility: group1.uniform?.visibility ?? GPUShaderStage.COMPUTE,
        textures,
        storageTextures,
        storages,
      };

      plan.hasAnyLocalResource =
        hasLocalUniform ||
        textures.length > 0 ||
        storageTextures.length > 0 ||
        storages.length > 0;
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
        st: storageTextures.map((x) => [
          x.binding,
          x.access,
          x.format,
          x.viewDimension,
        ]),
        s: storages.map((x) => [x.binding, x.visibility, x.bufferType]),
      });

      this._validateLocalBindingPlan(plan);
      return plan;
    }

    const hasExternalLocalResources =
      Object.keys(this.textures).length > 0 ||
      Object.keys(this.storageTextures).length > 0 ||
      this._hasAnyStorageInput();

    if (hasExternalLocalResources) {
      throw new Error(
        `[${this.label}] shader.contract.group1이 없는 상태에서는 textures/storageTextures/storages 자동 바인딩을 지원하지 않습니다. buildComputeShader()를 사용하세요.`
      );
    }

    const hasLocalUniform = Boolean(this.uniforms);
    const plan = {
      source: "fallback",
      hasLocalUniform,
      uniformBinding: hasLocalUniform ? 0 : null,
      uniformVisibility: GPUShaderStage.COMPUTE,
      textures: [],
      storageTextures: [],
      storages: [],
      hasAnyLocalResource: hasLocalUniform,
    };
    plan.layoutKey = JSON.stringify({
      source: plan.source,
      u: [plan.hasLocalUniform, plan.uniformBinding, plan.uniformVisibility],
      t: [],
      st: [],
      s: [],
    });

    this._validateLocalBindingPlan(plan);
    return plan;
  }

  _buildLocalResourceKey(plan) {
    if (!plan.hasAnyLocalResource) return null;

    const textureKey = plan.textures
      .map(
        (texture) => `${texture.slot}:${this._getTextureBindingKey(texture.resource)}`
      )
      .join("|");
    const storageTextureKey = plan.storageTextures
      .map(
        (texture) =>
          `${texture.slot}:${texture.binding}:${this._getStorageTextureBindingKey(texture.resource)}`
      )
      .join("|");
    const storageKey = plan.storages
      .map((storage) => `${storage.slot}:${storage.binding}:${storage.bindingKey}`)
      .join("|");

    return [textureKey, storageTextureKey, storageKey].filter(Boolean).join("||");
  }

  _syncLocalBindGroup() {
    const group1 = this.shaderContract?.group1;
    const shouldCheck =
      Boolean(this.uniforms) ||
      Object.keys(this.textures).length > 0 ||
      Object.keys(this.storageTextures).length > 0 ||
      this._hasAnyStorageInput() ||
      Boolean(group1?.uniform) ||
      (Array.isArray(group1?.textures) && group1.textures.length > 0) ||
      (Array.isArray(group1?.storageTextures) &&
        group1.storageTextures.length > 0) ||
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

    for (const texture of plan.textures) {
      layoutEntries.push({
        binding: texture.textureBinding,
        visibility: GPUShaderStage.COMPUTE,
        texture: {
          sampleType: texture.sampleType,
          viewDimension: texture.viewDimension,
          multisampled: texture.multisampled,
        },
      });
      layoutEntries.push({
        binding: texture.samplerBinding,
        visibility: GPUShaderStage.COMPUTE,
        sampler: {
          type: texture.samplerType,
        },
      });
      bindEntries.push({
        binding: texture.textureBinding,
        resource: texture.resource.getTextureView(),
      });
      bindEntries.push({
        binding: texture.samplerBinding,
        resource: texture.resource.getSampler(),
      });
    }

    for (const storageTexture of plan.storageTextures) {
      layoutEntries.push({
        binding: storageTexture.binding,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: {
          access: toStorageTextureLayoutAccess(storageTexture.access),
          format: storageTexture.format,
          viewDimension: storageTexture.viewDimension,
        },
      });
      bindEntries.push({
        binding: storageTexture.binding,
        resource: storageTexture.resource.getTextureView(),
      });
    }

    for (const storage of plan.storages) {
      layoutEntries.push({
        binding: storage.binding,
        visibility: storage.visibility,
        buffer: {
          type: storage.bufferType,
        },
      });
      bindEntries.push({
        binding: storage.binding,
        resource: storage.resource,
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
    for (const storageTexture of plan.storageTextures) {
      pushBinding(
        storageTexture.binding,
        `storageTexture:${storageTexture.name}`
      );
    }
    for (const storage of plan.storages) {
      pushBinding(storage.binding, `storage:${storage.name ?? storage.slot}`);
    }
  }

  _normalizeWorkgroups(workgroups) {
    const value = Array.isArray(workgroups)
      ? workgroups
      : Number.isFinite(workgroups)
        ? [workgroups, 1, 1]
        : null;

    if (!value) {
      throw new Error(
        `[${this.label}] workgroups는 [x, y, z] 배열 또는 숫자여야 합니다.`
      );
    }

    return [value[0], value[1] ?? 1, value[2] ?? 1].map((v, index) => {
      const n = Math.floor(Number(v));
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(
          `[${this.label}] workgroups[${index}]는 0보다 큰 정수여야 합니다.`
        );
      }
      return n;
    });
  }

  _resolveWorkgroups() {
    const resolved =
      typeof this.workgroups === "function"
        ? this.workgroups({
            renderer: this.renderer,
            pass: this,
          })
        : this.workgroups;

    if (resolved != null) {
      return this._normalizeWorkgroups(resolved);
    }

    if (this.defaultWorkgroupSize) {
      return this._normalizeWorkgroups(this.defaultWorkgroupSize);
    }
    return [1, 1, 1];
  }

  encode(commandEncoder) {
    this._syncLocalBindGroup();
    this._ensurePipeline();
    if (!this.pipeline) return;

    if (this.uniforms) {
      this.uniforms.upload();
    }
    this._uploadStorages();
    const [x, y, z] = this._resolveWorkgroups();

    const pass = commandEncoder.beginComputePass({
      label: `${this.label}.computePass`,
    });
    pass.setPipeline(this.pipeline);
    if (this.globalUniforms) {
      this.globalUniforms.bind(pass);
    }
    if (this.localBindGroup) {
      pass.setBindGroup(1, this.localBindGroup);
    }
    pass.dispatchWorkgroups(x, y, z);
    pass.end();
  }

  setWorkgroups(workgroups) {
    this.workgroups = workgroups;
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

  setTexture(nameOrSlot, texture) {
    const key = normalizeResourceKey(nameOrSlot, `${this.label}.setTexture`);
    if (texture == null) {
      delete this.textures[key];
    } else {
      this.textures[key] = texture;
    }

    if (this.isInitialized) {
      this._syncLocalBindGroup();
    }
  }

  setTextures(textures = {}) {
    this.textures = normalizeResourceCollectionInput(textures);
    if (!this.isInitialized) return;
    this._syncLocalBindGroup();
  }

  setStorageTexture(nameOrSlot, texture) {
    const key = normalizeResourceKey(
      nameOrSlot,
      `${this.label}.setStorageTexture`
    );
    if (texture == null) {
      delete this.storageTextures[key];
    } else {
      this.storageTextures[key] = texture;
    }

    if (this.isInitialized) {
      this._syncLocalBindGroup();
    }
  }

  setStorageTextures(storageTextures = {}) {
    this.storageTextures = normalizeResourceCollectionInput(storageTextures);
    if (!this.isInitialized) return;
    this._syncLocalBindGroup();
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
    this.storages = nextStorages;

    if (this.isInitialized) {
      this._syncLocalBindGroup();
    }
  }

  setStorages(storages = []) {
    this.storages = normalizeStorageCollectionInput(storages);
    if (!this.isInitialized) return;
    this._syncLocalBindGroup();
  }

  clearStorage(name) {
    if (!name || typeof name !== "string") {
      throw new Error(`[${this.label}] clearStorage(name): 이름 문자열이 필요합니다.`);
    }

    const entry = this._findStorageEntryByName(name);
    if (!entry) return false;

    if (Array.isArray(this.storages)) {
      const next = [...this.storages];
      next.splice(entry.slot, 1);
      this.storages = next;
    } else {
      const next = { ...this.storages };
      delete next[entry.key];
      this.storages = next;
    }

    if (this.isInitialized) {
      this._syncLocalBindGroup();
    }
    return true;
  }

  onResize(ctx) {
    if (ctx?.renderer) {
      this.renderer = ctx.renderer;
    }
    if (!this.isInitialized) return;
    if (!this.localBindGroupLayout && !this.localBindGroup) return;
    this._syncLocalBindGroup();
  }

  destroy() {
    this.uniforms?.destroy?.();
    this.uniforms = null;

    this.pipeline = null;
    this.pipelineLayout = null;
    this.shaderModule = null;
    this.localBindGroupLayout = null;
    this.localBindGroup = null;
    this.localBindingPlan = null;
    this._localLayoutKey = null;
    this._localResourceKey = null;
    this.shaderDataDefinitions = null;
    this.pendingUniforms = {};
    this._warnedNoLocalUniform = false;

    this.textures = {};
    this.storageTextures = {};
    this.storages = [];

    this.globalUniforms = null;
    this.renderer = null;
    this.device = null;
    this.shader = null;
    this.shaderCode = null;
    this.shaderContract = null;
    this.isInitialized = false;
  }
}
