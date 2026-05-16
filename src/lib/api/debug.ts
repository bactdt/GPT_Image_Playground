import type { TaskErrorDebugInfo } from '../../types'
import { DEV_PROXY_REQUEST_ID_HEADER } from '../devProxy'
import { isRecord } from '../guards'
import { getApiProtocol } from './config'
import { extractErrorMessage } from './errors'
import { createApiError, getDataUrlByteSize, isDataUrl, isHttpUrl } from './imageTransforms'
import {
  collectDebugImagePayloadFields,
  hasUsableImagePayload,
} from './payloadFacts'
import { tryParseJson } from './sse'
import type {
  ApiDebugRequestLogEntry,
  ApiDebugRequestSnapshot,
  ApiError,
  ApiInputImageFile,
  CallApiOptions,
  SharedRequestContext,
} from './types'

const DEBUG_STRING_PREVIEW_LIMIT = 1200
const DEBUG_ARRAY_ITEM_LIMIT = 10
const DEBUG_OBJECT_KEY_LIMIT = 30

export function readDevProxyRequestId(headers: Headers): string | undefined {
  const requestId = headers.get(DEV_PROXY_REQUEST_ID_HEADER)?.trim()
  return requestId || undefined
}

export function isSseResponse(response: Response): boolean {
  const contentType = response.headers.get('content-type')?.toLowerCase() || ''
  return contentType.includes('text/event-stream')
}

export function summarizeDebugString(value: string): string {
  if (/^Bearer\s+/i.test(value)) {
    return '[REDACTED_BEARER_TOKEN]'
  }

  if (value.startsWith('data:')) {
    const mime = /^data:([^;,]+)[^,]*,/.exec(value)?.[1] || 'unknown'
    return `[data-url mime=${mime} length=${value.length}]`
  }

  if (/^[A-Za-z0-9+/=]{600,}$/.test(value)) {
    return `[base64 length=${value.length}]`
  }

  if (value.length > DEBUG_STRING_PREVIEW_LIMIT) {
    return `${value.slice(0, DEBUG_STRING_PREVIEW_LIMIT)}...[truncated ${value.length - DEBUG_STRING_PREVIEW_LIMIT} chars]`
  }

  return value
}

export function sanitizeDebugValue(value: unknown, depth = 0, visited?: WeakSet<object>): unknown {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') {
    return value
  }

  if (typeof value === 'string') {
    return summarizeDebugString(value)
  }

  if (depth >= 5) {
    return '[max-depth-reached]'
  }

  const nextVisited = visited ?? new WeakSet<object>()
  if (typeof value === 'object' && value !== null) {
    if (nextVisited.has(value)) {
      return '[circular]'
    }
    nextVisited.add(value)
  }

  if (isRecord(value) && hasUsableImagePayload(value)) {
    const compact = collectDebugImagePayloadFields(value)
    for (const [key, fieldValue] of Object.entries(compact)) {
      compact[key] = summarizeDebugString(fieldValue)
    }

    return compact
  }

  if (Array.isArray(value)) {
    const items = value
      .slice(0, DEBUG_ARRAY_ITEM_LIMIT)
      .map((item) => sanitizeDebugValue(item, depth + 1, nextVisited))

    if (value.length > DEBUG_ARRAY_ITEM_LIMIT) {
      items.push(`[+${value.length - DEBUG_ARRAY_ITEM_LIMIT} more items]`)
    }

    return items
  }

  if (isRecord(value)) {
    const entries = Object.entries(value)
    const nextValue = Object.fromEntries(
      entries
        .slice(0, DEBUG_OBJECT_KEY_LIMIT)
        .map(([key, nestedValue]) => [key, sanitizeDebugValue(nestedValue, depth + 1, nextVisited)] as const),
    )

    if (entries.length > DEBUG_OBJECT_KEY_LIMIT) {
      nextValue.__truncatedKeys = entries.length - DEBUG_OBJECT_KEY_LIMIT
    }

    return nextValue
  }

  return String(value)
}

export function createDebugRequestLogEntry(
  ctx: SharedRequestContext,
  stage: string,
  method: string,
  url: string,
  requestBody?: unknown,
): ApiDebugRequestLogEntry {
  const entry: ApiDebugRequestLogEntry = {
    stage,
    method,
    url,
    requestHeaders: summarizeRequestHeadersForDebug(ctx.requestHeaders),
    requestBody: requestBody === undefined ? null : sanitizeDebugValue(requestBody),
    responseStatus: null,
    responseRequestId: null,
    responseBody: null,
    responseText: null,
  }
  ctx.debugLog.push(entry)
  return entry
}

export function attachDebugResponseMeta(
  entry: ApiDebugRequestLogEntry | undefined,
  response: Response,
): string | undefined {
  const requestId = readDevProxyRequestId(response.headers)
  if (entry) {
    entry.responseStatus = response.status
    entry.responseRequestId = requestId || null
  }
  return requestId
}

export function attachLocalDebugToError(
  error: unknown,
  opts: CallApiOptions,
  requestLog: ApiDebugRequestLogEntry[],
): ApiError {
  const apiError =
    error instanceof Error ? (error as ApiError) : createApiError(typeof error === 'string' ? error : String(error))

  if (isRecord(apiError.details) && isRecord(apiError.details.localDebug)) {
    return apiError
  }

  const localDebug: TaskErrorDebugInfo = {
    createdAt: Date.now(),
    requestId: apiError.requestId || null,
    status: typeof apiError.status === 'number' ? apiError.status : null,
    requestMode: opts.settings.requestMode,
    apiProtocol: getApiProtocol(opts.settings),
    baseUrl: opts.settings.baseUrl,
    model: opts.settings.model,
    responsesImageModel: opts.settings.responsesImageModel || null,
    responsesTransport: opts.settings.responsesTransport || null,
    responsesImageInputMode: opts.settings.responsesImageInputMode || null,
    responsesPromptRevisionMode: opts.settings.responsesPromptRevisionMode || null,
    request: buildLocalDebugRequestSnapshot(opts),
    requestLog: requestLog.length > 0 ? requestLog : null,
    failure: {
      message: apiError.message,
      status: typeof apiError.status === 'number' ? apiError.status : null,
      requestId: apiError.requestId || null,
      details: apiError.details,
    },
    details: apiError.details,
  }

  apiError.details = {
    localDebug,
  }
  return apiError
}

export async function buildApiErrorFromResponse(
  response: Response,
  logEntry?: ApiDebugRequestLogEntry,
): Promise<ApiError> {
  const requestId = attachDebugResponseMeta(logEntry, response)
  if (response.status === 524) {
    return createApiError(
      '上游站点处理超时（Cloudflare 524）。如果这次带了本地参考图，请优先改用公网图片 URL；若中转站支持 Responses 流式传输，也可优先启用 stream 模式后重试。',
      524,
      { requestId },
    )
  }

  let errorMessage = `HTTP ${response.status}`
  let responseBody: unknown = undefined
  let responseText: string | undefined

  try {
    const text = await response.text()
    const parsedPayload = tryParseJson(text)
    if (parsedPayload !== undefined) {
      responseBody = parsedPayload
      if (logEntry) {
        logEntry.responseBody = sanitizeDebugValue(parsedPayload)
      }
      errorMessage = extractErrorMessage(parsedPayload) || errorMessage
    } else if (text.trim()) {
      responseText = text
      if (logEntry) {
        logEntry.responseText = summarizeDebugString(text)
      }
      errorMessage = text
    }
  } catch {
    /* ignore */
  }

  const details: Record<string, unknown> = {}
  if (responseBody !== undefined) {
    details.responseBody = responseBody
  }
  if (responseText?.trim()) {
    details.responseText = responseText
  }

  return createApiError(errorMessage, response.status, {
    requestId,
    details: Object.keys(details).length > 0 ? details : undefined,
  })
}

function summarizeRequestHeadersForDebug(headers: Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      /authorization|api[-_]?key|token|secret|password/i.test(key)
        ? '[REDACTED]'
        : summarizeDebugString(value),
    ]),
  )
}

function summarizeInputImageForDebug(
  value: string,
  index: number,
): NonNullable<ApiDebugRequestSnapshot['inputImages']>[number] {
  if (isDataUrl(value)) {
    const mime = /^data:([^;,]+)[^,]*,/.exec(value)?.[1] || null
    return {
      index,
      kind: 'data_url',
      mime,
      sizeBytes: getDataUrlByteSize(value),
    }
  }

  if (isHttpUrl(value)) {
    return {
      index,
      kind: 'remote_url',
      url: value,
    }
  }

  return {
    index,
    kind: 'unknown',
  }
}

function summarizeInputImageFileForDebug(
  value: ApiInputImageFile,
  index: number,
): NonNullable<ApiDebugRequestSnapshot['inputImages']>[number] {
  return {
    index,
    kind: 'blob',
    mime: value.mimeType || value.blob.type || null,
    sizeBytes: value.blob.size,
  }
}

function summarizeMaskForDebug(
  value: string | undefined,
  file?: ApiInputImageFile,
): NonNullable<ApiDebugRequestSnapshot['editMask']> {
  if (file) {
    return {
      ...summarizeInputImageFileForDebug(file, 0),
      present: true,
    }
  }

  if (!value) {
    return {
      present: false,
      kind: 'unknown',
    }
  }

  const baseSummary = summarizeInputImageForDebug(value, 0)
  return {
    ...baseSummary,
    present: true,
  }
}

function buildLocalDebugRequestSnapshot(opts: CallApiOptions): ApiDebugRequestSnapshot {
  const inputImages = opts.inputImageFiles.length > 0
    ? opts.inputImageFiles.map((value, index) => summarizeInputImageFileForDebug(value, index))
    : opts.inputImageDataUrls.map((value, index) => summarizeInputImageForDebug(value, index))

  return {
    baseUrl: opts.settings.baseUrl,
    requestMode: opts.settings.requestMode,
    apiProtocol: getApiProtocol(opts.settings),
    model: opts.settings.model,
    responsesImageModel: opts.settings.responsesImageModel || null,
    responsesTransport: opts.settings.responsesTransport || null,
    responsesImageInputMode: opts.settings.responsesImageInputMode || null,
    responsesPromptRevisionMode: opts.settings.responsesPromptRevisionMode || null,
    prompt: opts.prompt,
    params: opts.params,
    inputImages,
    editMask: summarizeMaskForDebug(opts.editMaskDataUrl, opts.editMaskFile),
  }
}
