import { afterEach, describe, expect, it, vi } from 'vitest'
import { callKrillAsyncImagesApi } from '../krillAsync'
import type { CallApiOptions, SharedRequestContext } from '../types'

function tinyPngBase64(): string {
  return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
}

function fakeOptions(): CallApiOptions {
  return {
    settings: {
      baseUrl: 'https://blue-cherry-a344.bactdt.workers.dev/krill',
      apiKey: 'sk-test',
      model: 'cn-gpt-image-2',
      responsesImageModel: 'gpt-image-2',
      responsesTransport: 'json',
      responsesImageInputMode: 'auto',
      responsesPromptRevisionMode: 'allow',
      timeout: 900,
      apiProtocol: 'images',
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
  }
}

function fakeGenerateOptions(): CallApiOptions {
  return {
    ...fakeOptions(),
    prompt: 'generate this image',
    inputImageDataUrls: [],
    inputImageFiles: [],
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

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('callKrillAsyncImagesApi', () => {
  it('creates a multipart async job for Krill generations too', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobId: 'job_generate', status: 'queued' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        jobId: 'job_generate',
        status: 'succeeded',
        result: {
          data: [
            {
              b64_json: tinyPngBase64(),
            },
          ],
        },
      })))
    vi.stubGlobal('fetch', fetchMock)

    const resultPromise = callKrillAsyncImagesApi(fakeGenerateOptions(), fakeContext())
    await vi.advanceTimersByTimeAsync(3000)
    const result = await resultPromise

    expect(result.images).toHaveLength(1)
    const createInit = fetchMock.mock.calls[0][1] as RequestInit
    expect(createInit.body).toBeInstanceOf(FormData)
    const form = createInit.body as FormData
    expect(form.get('model')).toBe('cn-gpt-image-2')
    expect(form.get('prompt')).toBe('generate this image')
    expect(form.get('size')).toBe('1024x1024')
    expect(form.get('quality')).toBe('medium')
    expect(form.get('response_format')).toBe('b64_json')
    expect(form.get('image[]')).toBeNull()
  })

  it('creates a multipart async job and polls until image result is ready', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobId: 'job_1', status: 'queued' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobId: 'job_1', status: 'running' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        jobId: 'job_1',
        status: 'succeeded',
        result: {
          data: [
            {
              b64_json: tinyPngBase64(),
            },
          ],
        },
      })))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = fakeContext()
    const pending = callKrillAsyncImagesApi(fakeOptions(), ctx)
    await vi.advanceTimersByTimeAsync(3000)
    await vi.advanceTimersByTimeAsync(4000)
    const result = await pending

    expect(result.images).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[0][0]).toBe('https://blue-cherry-a344.bactdt.workers.dev/krill/v1/krill/jobs')
    expect(fetchMock.mock.calls[1][0]).toBe('https://blue-cherry-a344.bactdt.workers.dev/krill/v1/krill/jobs/job_1')
    expect(fetchMock.mock.calls[2][0]).toBe('https://blue-cherry-a344.bactdt.workers.dev/krill/v1/krill/jobs/job_1')

    const createInit = fetchMock.mock.calls[0][1] as RequestInit
    expect(createInit.method).toBe('POST')
    expect(createInit.body).toBeInstanceOf(FormData)
    expect((createInit.headers as Record<string, string>)['Content-Type']).toBeUndefined()
    expect(ctx.debugLog.map((entry) => entry.stage)).toEqual([
      'krill.jobs.create',
      'krill.jobs.poll',
      'krill.jobs.poll',
    ])
  })

  it('accepts nested data envelopes from the async backend', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          jobId: 'job_nested',
          status: 'succeeded',
          result: {
            data: [
              {
                b64_json: tinyPngBase64(),
              },
            ],
          },
        },
      })))
    vi.stubGlobal('fetch', fetchMock)

    const result = await callKrillAsyncImagesApi(fakeOptions(), fakeContext())

    expect(result.images).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
