import { describe, expect, it } from 'vitest'
import { buildImagesRequestSpec } from '../imagesRequestBuilder'
import type { CallApiOptions, ImagesRequestPlan, SharedRequestContext } from '../types'

function fakeOptions(overrides: Partial<CallApiOptions> = {}): CallApiOptions {
  return {
    settings: {
      baseUrl: 'https://blue-cherry-a344.bactdt.workers.dev/krill',
      apiKey: 'sk-test',
      model: 'gpt-image-2',
      responsesImageModel: 'gpt-image-2',
      responsesTransport: 'auto',
      responsesImageInputMode: 'auto',
      responsesPromptRevisionMode: 'allow',
      timeout: 900,
      apiProtocol: 'responses',
      requestMode: 'direct',
    },
    providerName: 'krill',
    prompt: 'edit this image',
    params: {
      size: 'auto',
      quality: 'high',
      output_format: 'webp',
      output_compression: 80,
      moderation: 'auto',
      n: 1,
    },
    inputImageDataUrls: [],
    inputImageFiles: [
      {
        blob: new Blob(['fake-image'], { type: 'image/png' }),
        fileName: 'input.png',
        mimeType: 'image/png',
      },
    ],
    ...overrides,
  }
}

function fakeContext(): SharedRequestContext {
  return {
    controller: new AbortController(),
    requestHeaders: {
      Authorization: 'Bearer sk-test',
    },
    proxyConfig: null,
    mime: 'image/png',
    forceProxy: false,
    debugLog: [],
  }
}

describe('buildImagesRequestSpec', () => {
  it('builds Krill edits as multipart FormData without JSON image_url payloads', async () => {
    const plan: ImagesRequestPlan = {
      id: 'multipart-body-json',
      transport: 'json',
      bodyMode: 'multipart',
    }

    const spec = await buildImagesRequestSpec({
      opts: fakeOptions(),
      plan,
      ctx: fakeContext(),
    })

    expect(spec.stage).toBe('images.edit.multipart-body-json')
    expect(spec.requestUrl).toBe('https://blue-cherry-a344.bactdt.workers.dev/krill/v1/images/edits')
    expect(spec.requestInit.body).toBeInstanceOf(FormData)
    expect((spec.requestInit.headers as Record<string, string>)['Content-Type']).toBeUndefined()
    expect(spec.debugBody).toMatchObject({
      model: 'cn-gpt-image-2',
      size: '1024x1024',
      quality: 'medium',
      output_format: 'png',
      moderation: 'low',
      bodyMode: 'multipart',
      imageCount: 1,
    })
    expect(JSON.stringify(spec.debugBody)).not.toContain('image_url')
    expect(JSON.stringify(spec.debugBody)).not.toContain('data-url')

    const form = spec.requestInit.body as FormData
    expect(form.get('model')).toBe('cn-gpt-image-2')
    expect(form.get('prompt')).toBe('edit this image')
    expect(form.get('size')).toBe('1024x1024')
    expect(form.get('quality')).toBe('medium')
    expect(form.get('output_format')).toBe('png')
    expect(form.get('moderation')).toBe('low')
    expect(form.get('image[]')).toBeInstanceOf(Blob)
  })
})
