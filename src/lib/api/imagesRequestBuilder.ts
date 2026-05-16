import { buildRequestUrl } from './config'
import { createApiError, dataUrlToBlob, isDataUrl, isHttpUrl } from './imageTransforms'
import { getImageExtensionFromMimeType } from '../imageMime'
import { isKrillProviderName, resolveKrillEditParams } from './providerCompat'
import type { ApiInputImageFile, CallApiOptions, ImagesRequestPlan, SharedRequestContext } from './types'

interface BuildImagesRequestSpecOptions {
  opts: Pick<
    CallApiOptions,
    | 'settings'
    | 'providerName'
    | 'prompt'
    | 'params'
    | 'inputImageDataUrls'
    | 'inputImageFiles'
    | 'editMaskDataUrl'
    | 'editMaskFile'
  >
  plan: ImagesRequestPlan
  ctx: SharedRequestContext
}

export type ImagesEditMultipartSource = BuildImagesRequestSpecOptions['opts']

export interface ImagesEditMultipartPayload {
  formData: FormData
  debugBody: Record<string, unknown>
}

export interface ImagesRequestSpec {
  stage: string
  requestUrl: string
  debugBody: unknown
  requestInit: RequestInit
}

function appendCommonEditFormFields(
  formData: FormData,
  opts: Pick<CallApiOptions, 'settings' | 'providerName' | 'prompt' | 'params'>,
  plan: ImagesRequestPlan,
) {
  const { settings, prompt, params } = opts
  if (isKrillProviderName(opts.providerName)) {
    const krillParams = resolveKrillEditParams(params)
    formData.append('model', krillParams.model)
    formData.append('prompt', prompt)
    formData.append('size', krillParams.size)
    formData.append('quality', krillParams.quality)
    formData.append('output_format', krillParams.output_format)
    formData.append('moderation', krillParams.moderation)
    return
  }

  formData.append('model', settings.model)
  formData.append('prompt', prompt)
  formData.append('size', params.size)
  formData.append('quality', params.quality)
  formData.append('output_format', params.output_format)
  formData.append('moderation', params.moderation)
  if (params.n > 1) {
    formData.append('n', String(params.n))
  }
  if (params.output_format !== 'png' && params.output_compression != null) {
    formData.append('output_compression', String(params.output_compression))
  }
  if (plan.transport === 'stream') {
    formData.append('stream', 'true')
  }
}

function resolveFileName(file: ApiInputImageFile, fallbackName: string): string {
  if (file.fileName?.trim()) {
    return file.fileName
  }

  const mimeType = file.mimeType || file.blob.type
  const ext = mimeType ? getImageExtensionFromMimeType(mimeType) : 'png'
  return `${fallbackName}.${ext}`
}

export async function buildImagesEditMultipartPayload(
  opts: ImagesEditMultipartSource,
  plan: ImagesRequestPlan,
): Promise<ImagesEditMultipartPayload> {
  const {
    settings,
    providerName,
    prompt,
    params,
    inputImageDataUrls,
    inputImageFiles,
    editMaskDataUrl,
    editMaskFile,
  } = opts
  const isKrillEdit = isKrillProviderName(providerName)
  const formData = new FormData()
  appendCommonEditFormFields(formData, opts, plan)

  inputImageFiles.forEach((file, index) => {
    formData.append('image[]', file.blob, resolveFileName(file, `input-${index + 1}`))
  })
  for (let index = 0; index < inputImageDataUrls.length; index += 1) {
    const dataUrl = inputImageDataUrls[index]
    const blob = await dataUrlToBlob(dataUrl)
    const ext = blob.type ? getImageExtensionFromMimeType(blob.type) : 'png'
    formData.append('image[]', blob, `input-${inputImageFiles.length + index + 1}.${ext}`)
  }

  if (editMaskFile) {
    formData.append('mask', editMaskFile.blob, resolveFileName(editMaskFile, 'mask'))
  } else if (editMaskDataUrl) {
    const maskBlob = await dataUrlToBlob(editMaskDataUrl)
    formData.append('mask', maskBlob, 'mask.png')
  }

  const debugParams = isKrillEdit
    ? resolveKrillEditParams(params)
    : {
        model: settings.model,
        size: params.size,
        quality: params.quality,
        output_format: params.output_format,
        moderation: params.moderation,
      }

  return {
    formData,
    debugBody: {
      model: debugParams.model,
      prompt,
      size: debugParams.size,
      quality: debugParams.quality,
      output_format: debugParams.output_format,
      moderation: debugParams.moderation,
      n: !isKrillEdit && params.n > 1 ? params.n : undefined,
      output_compression: !isKrillEdit && params.output_format !== 'png' ? params.output_compression : undefined,
      imageCount: inputImageFiles.length + inputImageDataUrls.length,
      hasMask: Boolean(editMaskFile || editMaskDataUrl),
      stream: !isKrillEdit && plan.transport === 'stream',
    },
  }
}

function buildImagesGenerateRequestSpec({
  opts,
  plan,
  ctx,
}: BuildImagesRequestSpecOptions): ImagesRequestSpec {
  const { settings, prompt, params } = opts
  const body: Record<string, unknown> = {
    model: settings.model,
    prompt,
    size: params.size,
    quality: params.quality,
    output_format: params.output_format,
    moderation: params.moderation,
  }

  if (params.output_format !== 'png' && params.output_compression != null) {
    body.output_compression = params.output_compression
  }
  if (params.n > 1) {
    body.n = params.n
  }
  if (plan.transport === 'stream') {
    body.stream = true
  }

  return {
    stage: `images.generate.${plan.id}`,
    requestUrl: buildRequestUrl(settings.baseUrl, 'images/generations', ctx),
    debugBody: body,
    requestInit: {
      method: 'POST',
      headers: {
        ...ctx.requestHeaders,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      body: JSON.stringify(body),
      signal: ctx.controller.signal,
    },
  }
}

async function buildImagesEditJsonRequestSpec({
  opts,
  plan,
  ctx,
}: BuildImagesRequestSpecOptions): Promise<ImagesRequestSpec> {
  const { settings, prompt, params, inputImageDataUrls, editMaskDataUrl } = opts
  const images = inputImageDataUrls.map((value) => {
    if (!isDataUrl(value) && !isHttpUrl(value)) {
      throw createApiError('编辑参考图格式不受支持，请使用本地图片或公网图片 URL')
    }
    return { image_url: value }
  })

  const body: Record<string, unknown> = {
    model: settings.model,
    prompt,
    images,
    size: params.size,
    quality: params.quality,
    output_format: params.output_format,
    moderation: params.moderation,
  }

  if (params.n > 1) {
    body.n = params.n
  }
  if (params.output_format !== 'png' && params.output_compression != null) {
    body.output_compression = params.output_compression
  }
  if (editMaskDataUrl) {
    if (!isDataUrl(editMaskDataUrl) && !isHttpUrl(editMaskDataUrl)) {
      throw createApiError('编辑蒙版格式不受支持，请使用本地图片或公网图片 URL')
    }
    body.mask = {
      image_url: editMaskDataUrl,
    }
  }
  if (plan.transport === 'stream') {
    body.stream = true
  }

  return {
    stage: `images.edit.${plan.id}`,
    requestUrl: buildRequestUrl(settings.baseUrl, 'images/edits', ctx),
    debugBody: {
      ...body,
      imageCount: inputImageDataUrls.length,
      hasMask: Boolean(editMaskDataUrl),
      bodyMode: plan.bodyMode,
    },
    requestInit: {
      method: 'POST',
      headers: {
        ...ctx.requestHeaders,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      body: JSON.stringify(body),
      signal: ctx.controller.signal,
    },
  }
}

async function buildImagesEditMultipartRequestSpec({
  opts,
  plan,
  ctx,
}: BuildImagesRequestSpecOptions): Promise<ImagesRequestSpec> {
  const { settings } = opts
  const { formData, debugBody } = await buildImagesEditMultipartPayload(opts, plan)

  return {
    stage: `images.edit.${plan.id}`,
    requestUrl: buildRequestUrl(settings.baseUrl, 'images/edits', ctx),
    debugBody: {
      ...debugBody,
      bodyMode: plan.bodyMode,
    },
    requestInit: {
      method: 'POST',
      headers: ctx.requestHeaders,
      cache: 'no-store',
      body: formData,
      signal: ctx.controller.signal,
    },
  }
}

export async function buildImagesRequestSpec(
  options: BuildImagesRequestSpecOptions,
): Promise<ImagesRequestSpec> {
  const { opts, plan } = options
  const isEdit = opts.inputImageDataUrls.length > 0 || opts.inputImageFiles.length > 0

  if (!isEdit) {
    return buildImagesGenerateRequestSpec(options)
  }

  if (plan.bodyMode === 'json') {
    return buildImagesEditJsonRequestSpec(options)
  }

  return buildImagesEditMultipartRequestSpec(options)
}
