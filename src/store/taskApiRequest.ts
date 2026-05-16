import { callImageApi } from '../lib/api'
import { isKrillProviderName } from '../lib/api/providerCompat'
import { getImageBlob } from '../lib/db'
import type { ApiInputImage, ApiImageAsset, CallApiResult } from '../lib/api'
import type { AppSettings, TaskRecord } from '../types'
import { getImageView } from './imageAssets'

export type TaskApiOutputImageAsset = ApiImageAsset

export interface TaskApiRequestHandlers {
  onFinalImages?: (images: TaskApiOutputImageAsset[]) => void | Promise<void>
  registerAbort?: (abort: () => void) => void
  throwIfAborted?: () => void
}

async function loadTaskInputImages(
  task: TaskRecord,
  throwIfAborted?: () => void,
  options: { preferBlob?: boolean } = {},
) {
  const inputImages: ApiInputImage[] = []

  for (const imageId of task.inputImageIds) {
    throwIfAborted?.()
    if (options.preferBlob) {
      try {
        const blob = await getImageBlob(imageId)
        throwIfAborted?.()
        if (blob) {
          inputImages.push({
            id: imageId,
            blob,
            mimeType: blob.type || null,
            fileName: `input-${inputImages.length + 1}.${resolveImageFileExtension(blob.type)}`,
          })
          continue
        }
      } catch {
        // 远程图片或旧数据回退到原有 data URL 读取路径。
      }
    }

    const dataUrl = await getImageView(imageId).getRawDataUrl()
    throwIfAborted?.()
    if (!dataUrl) {
      continue
    }

    inputImages.push({
      id: imageId,
      dataUrl,
    })
  }

  return inputImages
}

function resolveImageFileExtension(mimeType: string | null | undefined): string {
  const normalized = mimeType?.toLowerCase() || ''
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg'
  if (normalized.includes('webp')) return 'webp'
  return 'png'
}

async function loadTaskEditMask(
  task: TaskRecord,
  throwIfAborted?: () => void,
  options: { preferBlob?: boolean } = {},
) {
  if (!task.editMaskImageId) {
    return undefined
  }

  throwIfAborted?.()
  if (options.preferBlob) {
    try {
      const blob = await getImageBlob(task.editMaskImageId)
      throwIfAborted?.()
      if (blob) {
        return {
          blob,
          mimeType: blob.type || null,
          fileName: `mask.${resolveImageFileExtension(blob.type)}`,
          sourceImageId: task.editSourceImageId ?? null,
          selection: task.editSelection ?? null,
        }
      }
    } catch {
      // 远程图片或旧数据回退到原有 data URL 读取路径。
    }
  }

  const editMaskDataUrl = await getImageView(task.editMaskImageId).getRawDataUrl()
  throwIfAborted?.()
  if (!editMaskDataUrl) {
    throw new Error('局部编辑蒙版缺失，请重新选择编辑区域后再试')
  }

  return {
    dataUrl: editMaskDataUrl,
    sourceImageId: task.editSourceImageId ?? null,
    selection: task.editSelection ?? null,
  }
}

export async function callTaskImageApi(
  task: TaskRecord,
  settings: AppSettings,
  handlers: TaskApiRequestHandlers = {},
): Promise<CallApiResult> {
  const preferBlobInputs = isKrillProviderName(task.providerName) && (
    task.inputImageIds.length > 0 || Boolean(task.editMaskImageId)
  )
  const inputImages = await loadTaskInputImages(
    task,
    handlers.throwIfAborted,
    { preferBlob: preferBlobInputs },
  )
  const editMask = await loadTaskEditMask(
    task,
    handlers.throwIfAborted,
    { preferBlob: preferBlobInputs },
  )
  handlers.throwIfAborted?.()

  return callImageApi({
    settings,
    providerName: task.providerName ?? null,
    prompt: task.prompt,
    params: task.params,
    inputImages,
    editMask: editMask ?? null,
    onFinalImages: handlers.onFinalImages,
    registerAbort: handlers.registerAbort,
  })
}
