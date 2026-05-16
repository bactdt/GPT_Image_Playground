import type { TaskParams } from '../../types'

export const KRILL_IMAGE_MODEL = 'cn-gpt-image-2'

export function isKrillProviderName(providerName: string | null | undefined): boolean {
  return providerName?.trim().toLowerCase() === 'krill'
}

export function resolveKrillImageParams(params: TaskParams) {
  return {
    model: KRILL_IMAGE_MODEL,
    size: params.size && params.size !== 'auto' ? params.size : '1024x1024',
    quality: 'medium' as const,
    output_format: 'png' as const,
    moderation: 'low' as const,
  }
}

export const resolveKrillEditParams = resolveKrillImageParams
