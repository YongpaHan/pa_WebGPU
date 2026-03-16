import { createTextureFromImage, createTextureFromSource } from "webgpu-utils";

let nextTextureResourceInstanceId = 1;

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

function resolveStringSource(source) {
  if (isExternalUrl(source) || isRuntimeUrl(source)) {
    return source;
  }

  const normalized = source.replace(/^\.?\//, "").replace(/^\/+/, "");
  return `${import.meta.env.BASE_URL}${normalized}`;
}

export class TextureResource {
  constructor({ device, label = "texture resource" } = {}) {
    if (!device) throw new Error("TextureResource: device가 필요합니다.");

    this.device = device;
    this.label = label;

    this.texture = null;
    this.view = null;
    this.sampler = null;

    this.source = null;
    this.dynamic = false;

    this.width = 0;
    this.height = 0;
    this.format = "rgba8unorm";
    this.usage = 0;
    this.kind = "empty";
    this.autoResize = false;

    this._recreating = false;
    this.instanceId = nextTextureResourceInstanceId++;
    this.bindingVersion = 0;
    this.destroyed = false;
  }

  createEmpty({
    width,
    height,
    format = "rgba8unorm",
    usage = GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
    samplerSettings = null,
    viewSettings = null,
  }) {
    if (this.destroyed) {
      throw new Error("TextureResource: 이미 destroy된 리소스입니다.");
    }

    if (!Number.isFinite(width) || width <= 0) {
      throw new Error("TextureResource: width는 0보다 커야 합니다.");
    }
    if (!Number.isFinite(height) || height <= 0) {
      throw new Error("TextureResource: height는 0보다 커야 합니다.");
    }

    this.texture?.destroy?.();
    this.texture = this.device.createTexture({
      label: `${this.label}.texture`,
      size: [Math.floor(width), Math.floor(height), 1],
      format,
      usage,
    });

    this.view = this.texture.createView(viewSettings ?? {});
    this.sampler = this.device.createSampler(
      samplerSettings ?? {
        addressModeU: "repeat", // clamp-to-edge | repeat | mirror-repeat
        addressModeV: "repeat",
        magFilter: "linear",
        minFilter: "linear",
      }
    );

    this.width = Math.floor(width);
    this.height = Math.floor(height);
    this.format = format;
    this.usage = usage;
    this.viewSettings = viewSettings;
    this.samplerSettings = samplerSettings;
    this.kind = "empty";
    this.bindingVersion += 1;

    return this;
  }
  async createFromSource({
    source,
    dynamic = "auto",
    mips = true,
    flipY = true,
    format = "rgba8unorm",
    usage = GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
    samplerSettings = null,
    viewSettings = null,
  }) {
    if (this.destroyed) {
      throw new Error("TextureResource: 이미 destroy된 리소스입니다.");
    }
    if (!source) {
      throw new Error("TextureResource: 소스 경로(요소)가 필요합니다.");
    }
    const resolvedSource =
      typeof source === "string" ? resolveStringSource(source) : source;
    this.source = resolvedSource;
    const isUrl = typeof resolvedSource === "string";
    // this.dynamic = dynamic;
    if (dynamic === "auto") {
      this.dynamic =
        resolvedSource instanceof HTMLVideoElement ||
        resolvedSource instanceof HTMLCanvasElement ||
        (typeof OffscreenCanvas !== "undefined" &&
          resolvedSource instanceof OffscreenCanvas);
    } else {
      this.dynamic = Boolean(dynamic);
    }

    this.useMips = this.dynamic ? false : mips;

    //텍스처 생성(webgpu-utils 라이브러리 사용)
    this.texture?.destroy?.();
    const texture = isUrl
      ? await createTextureFromImage(this.device, resolvedSource, {
          mips: this.useMips,
          flipY,
          format,
          usage,
        })
      : createTextureFromSource(this.device, resolvedSource, {
          mips: this.useMips,
          flipY,
          format,
          usage,
        });
    this.texture = texture;
    //뷰 & 샘플러 생성
    this.view = this.texture.createView(viewSettings ?? {});
    this.sampler = this.device.createSampler(
      samplerSettings ?? {
        addressModeU: "clamp-to-edge", // clamp-to-edge | repeat | mirror-repeat
        addressModeV: "clamp-to-edge",
        magFilter: "linear",
        minFilter: "linear",
        mipmapFilter: this.useMips ? "linear" : undefined,
      }
    );

    this.width = this.texture.width;
    this.height = this.texture.height;
    this.format = format;
    this.usage = usage;
    this.viewSettings = viewSettings;
    this.samplerSettings = samplerSettings;
    this.flipY = flipY;
    this.kind = "source";
    this.bindingVersion += 1;

    return this;
  }

  setAutoResize(enabled) {
    if (this.destroyed) return this;
    this.autoResize = Boolean(enabled);
    return this;
  }

  resize(width, height) {
    if (this.destroyed) return false;
    if (this.kind !== "empty") return false;

    const nextWidth = Math.floor(width);
    const nextHeight = Math.floor(height);
    if (!Number.isFinite(nextWidth) || nextWidth <= 0) {
      throw new Error("TextureResource.resize: width는 0보다 커야 합니다.");
    }
    if (!Number.isFinite(nextHeight) || nextHeight <= 0) {
      throw new Error("TextureResource.resize: height는 0보다 커야 합니다.");
    }
    if (this.width === nextWidth && this.height === nextHeight) {
      return false;
    }

    this.createEmpty({
      width: nextWidth,
      height: nextHeight,
      format: this.format,
      usage: this.usage,
      samplerSettings: this.samplerSettings,
      viewSettings: this.viewSettings,
    });
    return true;
  }

  update(source = this.source) {
    if (this.destroyed) return this;
    if (!this.dynamic) return this;
    if (!source || !this.texture) return this;
    if (source) this.source = source;

    const width = source.videoWidth ?? source.width;
    const height = source.videoHeight ?? source.height;
    if (!width || !height) return this;

    if (width !== this.width || height !== this.height) {
      if (this._recreating) return this;
      this._recreating = true;

      void this.createFromSource({
        source,
        dynamic: true,
        mips: false,
        flipY: this.flipY,
        format: this.format,
        usage: this.usage,
        viewSettings: this.viewSettings,
        samplerSettings: this.samplerSettings,
      })
        .catch((err) => {
          console.error(`[${this.label}] recreate failed`, err);
        })
        .finally(() => {
          this._recreating = false;
        });

      return this;
    }

    this.device.queue.copyExternalImageToTexture(
      { source, flipY: this.flipY },
      { texture: this.texture },
      [width, height, 1]
    );

    return this;
  }

  getTextureView() {
    return this.view;
  }

  getSampler() {
    return this.sampler;
  }

  getBindingKey() {
    return `${this.instanceId}:${this.bindingVersion}`;
  }

  destroy() {
    if (this.destroyed) return;

    this.texture?.destroy?.();
    this.texture = null;
    this.source = null;
    this.dynamic = null;
    this.useMips = false;
    this.flipY = true;
    this.viewSettings = null;
    this.samplerSettings = null;
    this.view = null;
    this.sampler = null;
    this._recreating = false;
    this.kind = "empty";
    this.autoResize = false;

    this.destroyed = true;
  }
}
