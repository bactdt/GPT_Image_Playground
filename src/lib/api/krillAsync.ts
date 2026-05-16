import { buildApiUrl } from '../devProxy'
import { isRecord } from '../guards'
import {
  buildApiErrorFromResponse,
  createDebugRequestLogEntry,
  sanitizeDebugValue,
} from './debug'
import { createApiError, emitFinalImages } from './imageTransforms'
import { buildImagesEditMultipartPayload } from './imagesRequestBuilder'
import {
  buildTaskResponseMetaFromCalls,
  collectImageGenerationCallsFromPayload,
  parseImagesFromPayload,
} from './imagePayload'
import { resolveKrillImageParams } from './providerCompat'
import { readImagesPayload } from './payloadText'
import { extractErrorMessage } from './errors'
import type {
  ApiDebugRequestLogEntry,
  ApiImageAsset,
  CallApiOptions,
  CallApiResult,
  ImagesRequestPlan,
  SharedRequestContext,
} from './types'

const KRILL_ASYNC_CREATE_PATH = 'krill/jobs'
const KRILL_ASYNC_POLL_INTERVAL_MS = 3000
const KRILL_ASYNC_MAX_POLL_INTERVAL_MS = 8000

type KrillAsyncJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'

interface NormalizedKrillJob {
  jobId: string
  status?: KrillAsyncJobStatus
  payload?: unknown
}

const KRILL_MULTIPART_JSON_PLAN: ImagesRequestPlan = {
  id: 'multipart-body-json',
  transport: 'json',
  bodyMode: 'multipart',
}

interface KrillAsyncCreatePayload {
  body: BodyInit
  debugBody: Record<string, unknown>
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '')
}

function buildRequestUrl(baseUrl: string, path: string, ctx: SharedRequestContext): string {
  return buildApiUrl(baseUrl, path, ctx.proxyConfig, { forceProxy: ctx.forceProxy })
}

function buildPollUrl(createUrl: string, jobId: string): string {
  return `${trimTrailingSlashes(createUrl)}/${encodeURIComponent(jobId)}`
}

function readJobId(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null
  }

  const directJobId = payload.jobId ?? payload.id
  if (typeof directJobId === 'string' && directJobId.trim()) {
    return directJobId.trim()
  }

  if (isRecord(payload.data)) {
    const nestedJobId = payload.data.jobId ?? payload.data.id
    if (typeof nestedJobId === 'string' && nestedJobId.trim()) {
      return nestedJobId.trim()
    }
  }

  return null
}

function readJobStatus(payload: unknown): KrillAsyncJobStatus | undefined {
  if (!isRecord(payload)) {
    return undefined
  }

  const rawStatus = typeof payload.status === 'string'
    ? payload.status
    : isRecord(payload.data) && typeof payload.data.status === 'string'
      ? payload.data.status
      : ''
  const normalized = rawStatus.trim().toLowerCase()
  if (
    normalized === 'queued' ||
    normalized === 'running' ||
    normalized === 'succeeded' ||
    normalized === 'failed' ||
    normalized === 'canceled'
  ) {
    return normalized
  }
  if (normalized === 'completed' || normalized === 'done' || normalized === 'success') {
    return 'succeeded'
  }
  if (normalized === 'error') {
    return 'failed'
  }

  return undefined
}

function readResultPayload(payload: unknown): unknown {
  if (!isRecord(payload)) {
    return payload
  }

  if (payload.result !== undefined) {
    return payload.result
  }
  if (payload.response !== undefined) {
    return payload.response
  }
  if (isRecord(payload.data)) {
    const nestedPayload = payload.data
    if (
      nestedPayload.result !== undefined ||
      nestedPayload.response !== undefined ||
      nestedPayload.output !== undefined ||
      nestedPayload.data !== undefined
    ) {
      return readResultPayload(nestedPayload)
    }
  }
  if (payload.output !== undefined || payload.data !== undefined) {
    return payload
  }

  return payload
}

function normalizeJobPayload(payload: unknown, fallbackJobId?: string): NormalizedKrillJob {
  const jobId = readJobId(payload) ?? fallbackJobId ?? ''
  return {
    jobId,
    status: readJobStatus(payload),
    payload: readResultPayload(payload),
  }
}

function getJobErrorMessage(payload: unknown): string {
  return extractErrorMessage(payload) || 'Krill 异步任务处理失败'
}

function waitForPollDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }

    const timeoutId = globalThis.setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        globalThis.clearTimeout(timeoutId)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
  })
}

async function readJsonResponse(
  response: Response,
  logEntry: ApiDebugRequestLogEntry,
): Promise<unknown> {
  if (!response.ok) {
    throw await buildApiErrorFromResponse(response, logEntry)
  }

  return readImagesPayload(response, logEntry)
}

async function buildKrillAsyncCreatePayload(
  opts: CallApiOptions,
): Promise<KrillAsyncCreatePayload> {
  const isEdit = opts.inputImageDataUrls.length > 0 || opts.inputImageFiles.length > 0
  if (isEdit) {
    const { formData, debugBody } = await buildImagesEditMultipartPayload(opts, KRILL_MULTIPART_JSON_PLAN)
    return {
      body: formData,
      debugBody: {
        ...debugBody,
        bodyMode: 'multipart',
        asyncMode: 'job_polling',
      },
    }
  }

  const params = resolveKrillImageParams(opts.params)
  const formData = new FormData()
  formData.append('model', params.model)
  formData.append('prompt', opts.prompt)
  formData.append('size', params.size)
  formData.append('quality', params.quality)
  formData.append('output_format', params.output_format)
  formData.append('moderation', params.moderation)
  formData.append('response_format', 'b64_json')

  return {
    body: formData,
    debugBody: {
      model: params.model,
      prompt: opts.prompt,
      size: params.size,
      quality: params.quality,
      output_format: params.output_format,
      moderation: params.moderation,
      response_format: 'b64_json',
      imageCount: 0,
      hasMask: false,
      bodyMode: 'multipart',
      asyncMode: 'job_polling',
    },
  }
}

async function pollKrillJob(
  createUrl: string,
  jobId: string,
  opts: CallApiOptions,
  ctx: SharedRequestContext,
): Promise<unknown> {
  let pollDelayMs = KRILL_ASYNC_POLL_INTERVAL_MS

  while (true) {
    await waitForPollDelay(pollDelayMs, ctx.controller.signal)
    const pollUrl = buildPollUrl(createUrl, jobId)
    const debugLogEntry = createDebugRequestLogEntry(
      ctx,
      'krill.jobs.poll',
      'GET',
      pollUrl,
      { jobId },
    )
    const response = await fetch(pollUrl, {
      method: 'GET',
      headers: ctx.requestHeaders,
      cache: 'no-store',
      signal: ctx.controller.signal,
    })
    const payload = await readJsonResponse(response, debugLogEntry)
    const job = normalizeJobPayload(payload, jobId)
    debugLogEntry.responseBody = sanitizeDebugValue(payload)

    if (job.status === 'succeeded') {
      return job.payload
    }
    if (job.status === 'failed' || job.status === 'canceled') {
      throw createApiError(getJobErrorMessage(payload), response.status, {
        details: {
          jobId,
          responseBody: payload,
        },
      })
    }

    pollDelayMs = Math.min(KRILL_ASYNC_MAX_POLL_INTERVAL_MS, pollDelayMs + 1000)
  }
}

export async function callKrillAsyncImagesApi(
  opts: CallApiOptions,
  ctx: SharedRequestContext,
): Promise<CallApiResult> {
  const createUrl = buildRequestUrl(opts.settings.baseUrl, KRILL_ASYNC_CREATE_PATH, ctx)
  const { body, debugBody } = await buildKrillAsyncCreatePayload(opts)
  const createLogEntry = createDebugRequestLogEntry(
    ctx,
    'krill.jobs.create',
    'POST',
    createUrl,
    debugBody,
  )

  const createResponse = await fetch(createUrl, {
    method: 'POST',
    headers: ctx.requestHeaders,
    cache: 'no-store',
    body,
    signal: ctx.controller.signal,
  })
  const createPayload = await readJsonResponse(createResponse, createLogEntry)
  const createdJob = normalizeJobPayload(createPayload)
  if (!createdJob.jobId) {
    throw createApiError('Krill 异步任务创建成功，但后端未返回 jobId', createResponse.status, {
      details: {
        responseBody: createPayload,
      },
    })
  }

  const resultPayload = createdJob.status === 'succeeded'
    ? createdJob.payload
    : await pollKrillJob(createUrl, createdJob.jobId, opts, ctx)
  const responseMetaFromCalls = buildTaskResponseMetaFromCalls(
    collectImageGenerationCallsFromPayload(resultPayload),
  )
  const images: ApiImageAsset[] = await parseImagesFromPayload(
    resultPayload,
    ctx.mime,
    ctx.controller.signal,
  )

  if (!images.length) {
    throw createApiError('Krill 异步任务已完成，但未返回可用图片数据', 200, {
      details: {
        jobId: createdJob.jobId,
        responseBody: resultPayload,
      },
    })
  }

  await emitFinalImages(opts, images)
  return {
    images,
    responseMeta: {
      ...(responseMetaFromCalls ?? {}),
      transport: {
        requested: opts.settings.responsesTransport,
        actual: 'json',
        fallbackFromStream: false,
      },
    },
  }
}
