import { normalizeProxyTargetBaseUrl, readClientDevProxyConfig } from '../devProxy'
import { getApiProtocol, MIME_MAP } from './config'
import { attachLocalDebugToError } from './debug'
import { callImagesApi } from './images'
import { createApiError, normalizeEditMaskForProvider } from './imageTransforms'
import { isKrillProviderName, KRILL_IMAGE_MODEL } from './providerCompat'
import { callResponsesApi } from './responses'
import type {
  ApiDebugRequestLogEntry,
  CallApiOptions,
  CallApiResult,
  CallImageApiIntent,
  SharedRequestContext,
} from './types'

interface ApiCallRuntime {
  baseOpts: CallApiOptions
  normalizedOpts: CallApiOptions
  ctx: SharedRequestContext
  timeoutId: ReturnType<typeof setTimeout>
}

function resolveEditSourceImageIndex(intent: CallImageApiIntent): number | undefined {
  const sourceImageId = intent.editMask?.sourceImageId
  if (sourceImageId == null) {
    return undefined
  }

  const editSourceImageIndex = intent.inputImages.findIndex((image) => image.id === sourceImageId)
  return editSourceImageIndex >= 0 ? editSourceImageIndex : undefined
}

function buildCallApiOptions(intent: CallImageApiIntent): CallApiOptions {
  const rawSettings = import.meta.env.DEV
    ? intent.settings
    : {
        ...intent.settings,
        requestMode: 'direct' as const,
      }
  const settings = isKrillProviderName(intent.providerName)
    ? {
        ...rawSettings,
        apiProtocol: 'images' as const,
        model: KRILL_IMAGE_MODEL,
        responsesTransport: 'json' as const,
      }
    : rawSettings

  return {
    settings,
    providerName: intent.providerName ?? null,
    prompt: intent.prompt,
    params: intent.params,
    inputImageDataUrls: intent.inputImages.flatMap((image) =>
      image.dataUrl ? [image.dataUrl] : [],
    ),
    inputImageFiles: intent.inputImages.flatMap((image) =>
      image.blob
        ? [{
            blob: image.blob,
            id: image.id,
            fileName: image.fileName,
            mimeType: image.mimeType,
          }]
        : [],
    ),
    editMaskDataUrl: intent.editMask?.dataUrl,
    editMaskFile: intent.editMask?.blob
      ? {
          blob: intent.editMask.blob,
          fileName: intent.editMask.fileName,
          mimeType: intent.editMask.mimeType,
          id: intent.editMask.sourceImageId ?? undefined,
        }
      : undefined,
    editSelection: intent.editMask?.selection ?? null,
    editSourceImageIndex: resolveEditSourceImageIndex(intent),
    onFinalImages: intent.onFinalImages,
    registerAbort: intent.registerAbort,
  }
}

function createApiCallRuntime(intent: CallImageApiIntent): ApiCallRuntime {
  const baseOpts = buildCallApiOptions(intent)
  const mime = MIME_MAP[baseOpts.params.output_format] || 'image/png'
  const proxyConfig = readClientDevProxyConfig()
  const forceProxy = import.meta.env.DEV && baseOpts.settings.requestMode === 'local_proxy'
  const debugLog: ApiDebugRequestLogEntry[] = []
  const requestHeaders: Record<string, string> = {
    Authorization: `Bearer ${baseOpts.settings.apiKey}`,
  }
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort('timeout'), baseOpts.settings.timeout * 1000)
  baseOpts.registerAbort?.(() => controller.abort('user'))

  return {
    baseOpts,
    normalizedOpts: baseOpts,
    timeoutId,
    ctx: {
      controller,
      requestHeaders,
      proxyConfig,
      mime,
      forceProxy,
      debugLog,
    },
  }
}

async function prepareApiCallRuntime(runtime: ApiCallRuntime): Promise<void> {
  const { baseOpts, ctx } = runtime

  if (ctx.forceProxy && !ctx.proxyConfig?.enabled) {
    throw createApiError(
      '本地代理模式已启用，但未检测到可用的开发代理。请确认 dev-proxy.config.json 存在，并重启 npm run dev。',
    )
  }

  if (ctx.forceProxy) {
    const proxyTargetBaseUrl = normalizeProxyTargetBaseUrl(baseOpts.settings.baseUrl)
    if (!proxyTargetBaseUrl) {
      throw createApiError('API URL 无效，请检查设置中的 API URL')
    }

    ctx.requestHeaders['X-Dev-Proxy-Target'] = proxyTargetBaseUrl
  }

  if (baseOpts.editMaskDataUrl == null) {
    runtime.normalizedOpts = baseOpts
    return
  }

  runtime.normalizedOpts = {
    ...baseOpts,
    editMaskDataUrl: await normalizeEditMaskForProvider(
      baseOpts.editMaskDataUrl,
      baseOpts.editSelection,
      ctx.controller.signal,
    ),
  }
}

async function executeApiCallRuntime(runtime: ApiCallRuntime): Promise<CallApiResult> {
  if (getApiProtocol(runtime.normalizedOpts.settings) === 'responses') {
    return await callResponsesApi(runtime.normalizedOpts, runtime.ctx)
  }

  return await callImagesApi(runtime.normalizedOpts, runtime.ctx)
}

export async function callImageApi(intent: CallImageApiIntent): Promise<CallApiResult> {
  const runtime = createApiCallRuntime(intent)

  try {
    await prepareApiCallRuntime(runtime)
    return await executeApiCallRuntime(runtime)
  } catch (error) {
    throw attachLocalDebugToError(error, runtime.normalizedOpts, runtime.ctx.debugLog)
  } finally {
    clearTimeout(runtime.timeoutId)
  }
}
