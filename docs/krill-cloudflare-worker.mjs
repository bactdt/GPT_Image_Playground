const TARGET_INPUT = "https://newimage.9z1.me";
const TARGET_KRILL = "https://api.krill-ai.com/v1";

const JOB_TTL_SECONDS = 60 * 60 * 24;
const JOB_PREFIX = "krill:job:";
const OBJECT_PREFIX = "krill/jobs";
const MAX_KRILL_ATTEMPTS = 4;
const KRILL_RETRY_DELAYS_SECONDS = [45, 90, 180];
const RETRYABLE_UPSTREAM_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524]);

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const jobRoute = matchKrillJobRoute(url.pathname);

    if (jobRoute) {
      if (request.method === "POST" && !jobRoute.jobId) {
        return createKrillJob(request, env, cors);
      }
      if (request.method === "GET" && jobRoute.jobId) {
        return getKrillJob(jobRoute.jobId, env, cors);
      }
      return json({ error: "Method not allowed" }, 405, cors);
    }

    return proxyRequest(request, env, cors);
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      const jobId = message.body && message.body.jobId;
      try {
        if (typeof jobId !== "string" || !jobId) {
          throw new Error("Queue message missing jobId");
        }
        await processKrillJob(jobId, env);
        message.ack && message.ack();
      } catch (error) {
        console.error("Krill queue job failed", jobId, error);
        message.ack && message.ack();
      }
    }
  },
};

async function proxyRequest(request, env, cors) {
  const url = new URL(request.url);
  let target;
  let upstreamPath;
  let isKrill = false;

  if (url.pathname === "/input" || url.pathname.startsWith("/input/")) {
    target = TARGET_INPUT;
    upstreamPath = url.pathname.replace(/^\/input/, "");
  } else if (url.pathname === "/krill" || url.pathname.startsWith("/krill/")) {
    target = TARGET_KRILL;
    upstreamPath = url.pathname.replace(/^\/krill/, "").replace(/^\/v1/, "");
    isKrill = true;
  } else {
    return json(
      {
        error: "Unknown proxy route",
        message: "Use /input/... or /krill/...",
      },
      404,
      cors,
    );
  }

  if (!upstreamPath) upstreamPath = "/";
  if (!upstreamPath.startsWith("/")) upstreamPath = "/" + upstreamPath;

  const upstream = target + upstreamPath + url.search;
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");

  if (isKrill && env.KRILL_API_KEY && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${env.KRILL_API_KEY}`);
  }

  const body = request.method === "GET" || request.method === "HEAD"
    ? undefined
    : isKrill
      ? await buildKrillProxyBody(request, upstreamPath, headers)
      : request.body;

  let response;
  try {
    response = await fetch(upstream, {
      method: request.method,
      headers,
      body,
      redirect: "follow",
    });
  } catch (error) {
    return json(
      {
        error: "Upstream fetch failed",
        message: errorMessage(error),
        upstream,
      },
      502,
      cors,
    );
  }

  const responseHeaders = new Headers(response.headers);
  applyCors(responseHeaders, cors);
  responseHeaders.delete("content-length");
  responseHeaders.delete("content-encoding");
  responseHeaders.set("X-Upstream-URL", upstream);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

async function buildKrillProxyBody(request, upstreamPath, headers) {
  if (request.method !== "POST" || upstreamPath !== "/images/generations") {
    return request.body;
  }

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return request.body;
  }

  const text = await request.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return text;
  }

  const normalized = {
    ...payload,
    model: "cn-gpt-image-2",
    size: normalizeSize(typeof payload.size === "string" ? payload.size : ""),
    quality: "medium",
    output_format: "png",
    moderation: "low",
    response_format: "b64_json",
  };
  delete normalized.output_compression;
  delete normalized.stream;
  delete normalized.n;

  headers.set("Content-Type", "application/json");
  return JSON.stringify(normalized);
}

async function createKrillJob(request, env, cors) {
  const bindingError = requireAsyncBindings(env);
  if (bindingError) return json(bindingError, 500, cors);

  let form;
  try {
    form = await request.formData();
  } catch (error) {
    return json({ error: "Invalid multipart/form-data", message: errorMessage(error) }, 400, cors);
  }

  const prompt = stringField(form, "prompt");
  const images = [...filesField(form, "image[]"), ...filesField(form, "image")];
  const mask = firstFileField(form, "mask");

  if (!prompt) {
    return json({ error: "Missing prompt" }, 400, cors);
  }
  const authHeader = resolveIncomingAuth(request, env);
  if (!authHeader) {
    return json({ error: "Missing Authorization header or KRILL_API_KEY secret" }, 401, cors);
  }

  const jobId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const files = [];

  for (let index = 0; index < images.length; index += 1) {
    const file = images[index];
    const fileName = safeFileName(file.name, `image-${index + 1}${extensionForType(file.type)}`);
    const key = `${OBJECT_PREFIX}/${jobId}/input-${index + 1}-${fileName}`;
    await putFile(env, key, file);
    files.push({
      field: "image[]",
      key,
      fileName,
      contentType: file.type || "application/octet-stream",
    });
  }

  let maskFile = null;
  if (mask) {
    const fileName = safeFileName(mask.name, `mask${extensionForType(mask.type)}`);
    const key = `${OBJECT_PREFIX}/${jobId}/${fileName}`;
    await putFile(env, key, mask);
    maskFile = {
      field: "mask",
      key,
      fileName,
      contentType: mask.type || "application/octet-stream",
    };
  }

  const job = {
    jobId,
    status: "queued",
    createdAt,
    updatedAt: createdAt,
    kind: images.length > 0 || mask ? "edit" : "generate",
    params: {
      model: "cn-gpt-image-2",
      prompt,
      size: normalizeSize(stringField(form, "size")),
      quality: normalizeQuality(stringField(form, "quality")),
      output_format: "png",
      moderation: "low",
    },
    files,
    maskFile,
    authHeader: env.KRILL_API_KEY ? undefined : authHeader,
  };

  await saveJob(env, job);
  await env.KRILL_QUEUE.send({ jobId });

  return json({ jobId, status: "queued" }, 202, cors);
}

async function getKrillJob(jobId, env, cors) {
  const bindingError = requireAsyncBindings(env);
  if (bindingError) return json(bindingError, 500, cors);

  const job = await loadJob(env, jobId);
  if (!job) {
    return json({ error: "Job not found", jobId }, 404, cors);
  }

  if (job.status === "succeeded") {
    const result = await readResult(env, job);
    await cleanupResultObject(env, job);
    return json({ jobId, status: "succeeded", result }, 200, cors);
  }

  if (job.status === "failed" || job.status === "canceled") {
    return json({ jobId, status: job.status, error: job.error || { message: "Krill job failed" } }, 200, cors);
  }

  return json(
    {
      jobId,
      status: job.status || "queued",
      attempt: job.attempt,
      nextRetryAt: job.nextRetryAt,
      lastError: job.lastError,
    },
    200,
    cors,
  );
}

async function processKrillJob(jobId, env) {
  let job = await loadJob(env, jobId);
  if (!job || job.status === "succeeded" || job.status === "failed") return;

  const attempt = Number(job.attempt || 0) + 1;
  job = {
    ...job,
    attempt,
    status: "running",
    updatedAt: new Date().toISOString(),
    lastError: undefined,
    nextRetryAt: undefined,
  };
  await saveJob(env, job);

  try {
    const upstreamRequest = await buildKrillUpstreamJobRequest(job, env, attempt);
    const response = await fetch(upstreamRequest.url, upstreamRequest.init);
    const payload = normalizeImagePayload(await readPayload(response));

    if (!response.ok) {
      throw new UpstreamHttpError(
        extractPayloadMessage(payload) || `Krill upstream returned ${response.status}`,
        response.status,
        payload,
      );
    }
    if (!hasUsableImagePayload(payload)) {
      throw new UpstreamHttpError(
        "Krill upstream returned success but no image data",
        502,
        payload,
      );
    }

    const resultKey = `${OBJECT_PREFIX}/${jobId}/result.json`;
    await env.KRILL_UPLOADS.put(resultKey, JSON.stringify(payload), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });

    await saveJob(env, {
      ...job,
      status: "succeeded",
      updatedAt: new Date().toISOString(),
      resultKey,
      error: undefined,
      authHeader: undefined,
    });
    if (job.kind === "edit") {
      await cleanupInputObjects(env, job);
    }
  } catch (error) {
    if (shouldRetryKrillJob(error, attempt)) {
      const delaySeconds = retryDelaySeconds(attempt);
      const nextRetryAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
      await saveJob(env, {
        ...job,
        status: "queued",
        updatedAt: new Date().toISOString(),
        nextRetryAt,
        lastError: {
          message: errorMessage(error),
          status: error.status,
          attempt,
          payloadSummary: summarizePayload(error.payload),
        },
      });
      await env.KRILL_QUEUE.send({ jobId }, { delaySeconds });
      return;
    }

    await saveJob(env, {
      ...job,
      status: "failed",
      updatedAt: new Date().toISOString(),
      error: {
        message: errorMessage(error),
        status: error.status,
        payloadSummary: summarizePayload(error.payload),
      },
      authHeader: undefined,
    });
    if (job.kind === "edit") {
      await cleanupInputObjects(env, job);
    }
  }
}

async function buildKrillUpstreamJobRequest(job, env, attempt) {
  const headers = new Headers();
  const authHeader = env.KRILL_API_KEY ? `Bearer ${env.KRILL_API_KEY}` : job.authHeader;
  if (authHeader) headers.set("Authorization", authHeader);

  if (job.kind === "generate") {
    const body = buildKrillGenerateBody(job, attempt);
    headers.set("Content-Type", "application/json");
    return {
      url: `${TARGET_KRILL}/images/generations`,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
    };
  }

  const form = new FormData();
  form.append("model", "cn-gpt-image-2");
  form.append("prompt", job.params.prompt);
  form.append("size", job.params.size || "1024x1024");
  form.append("quality", job.params.quality || "medium");
  form.append("output_format", "png");
  form.append("moderation", "low");
  form.append("response_format", "b64_json");

  for (const file of job.files || []) {
    const blob = await readFileBlob(env, file);
    form.append(resolveUpstreamImageFieldName(attempt), blob, file.fileName || "image.png");
  }

  if (job.maskFile) {
    const blob = await readFileBlob(env, job.maskFile);
    form.append("mask", blob, job.maskFile.fileName || "mask.png");
  }

  return {
    url: `${TARGET_KRILL}/images/edits`,
    init: {
      method: "POST",
      headers,
      body: form,
    },
  };
}

function buildKrillGenerateBody(job, attempt) {
  const body = {
    model: "cn-gpt-image-2",
    prompt: job.params.prompt,
    size: "512x512",
    quality: "medium",
    output_format: "png",
    moderation: "low",
  };

  if (attempt <= 2) {
    body.response_format = "b64_json";
  }
  if (attempt === 3) {
    body.size = "1024x1024";
  }
  if (attempt >= 4) {
    body.quality = "standard";
  }

  return body;
}

function matchKrillJobRoute(pathname) {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const patterns = [
    /^\/krill\/v1\/krill\/jobs(?:\/([^/]+))?$/,
    /^\/krill\/krill\/jobs(?:\/([^/]+))?$/,
    /^\/v1\/krill\/jobs(?:\/([^/]+))?$/,
    /^\/krill\/jobs(?:\/([^/]+))?$/,
  ];

  for (const pattern of patterns) {
    const match = path.match(pattern);
    if (match) {
      return { jobId: match[1] ? decodeURIComponent(match[1]) : null };
    }
  }
  return null;
}

function requireAsyncBindings(env) {
  const missing = [];
  if (!env.JOBS) missing.push("JOBS");
  if (!env.KRILL_UPLOADS) missing.push("KRILL_UPLOADS");
  if (!env.KRILL_QUEUE) missing.push("KRILL_QUEUE");
  return missing.length > 0 ? { error: "Missing Worker bindings", missing } : null;
}

class UpstreamHttpError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = "UpstreamHttpError";
    this.status = status;
    this.payload = payload;
  }
}

function shouldRetryKrillJob(error, attempt) {
  return (
    attempt < MAX_KRILL_ATTEMPTS &&
    error &&
    typeof error.status === "number" &&
    RETRYABLE_UPSTREAM_STATUS.has(error.status)
  );
}

function retryDelaySeconds(attempt) {
  return KRILL_RETRY_DELAYS_SECONDS[Math.max(0, attempt - 1)] || KRILL_RETRY_DELAYS_SECONDS.at(-1) || 60;
}

function resolveUpstreamImageFieldName(attempt) {
  return attempt <= 1 ? "image[]" : "image";
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  const requestedHeaders = request.headers.get("Access-Control-Request-Headers");
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": requestedHeaders || "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin, Access-Control-Request-Headers",
  };
}

function applyCors(headers, cors) {
  for (const [key, value] of Object.entries(cors)) {
    headers.set(key, value);
  }
}

function json(payload, status, cors) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    ...cors,
  });
  return new Response(JSON.stringify(payload), { status, headers });
}

function jobKey(jobId) {
  return `${JOB_PREFIX}${jobId}`;
}

async function saveJob(env, job) {
  await env.JOBS.put(jobKey(job.jobId), JSON.stringify(job), {
    expirationTtl: JOB_TTL_SECONDS,
  });
}

async function loadJob(env, jobId) {
  const text = await env.JOBS.get(jobKey(jobId));
  return text ? JSON.parse(text) : null;
}

async function putFile(env, key, file) {
  await env.KRILL_UPLOADS.put(key, file, {
    httpMetadata: {
      contentType: file.type || "application/octet-stream",
    },
  });
}

async function readFileBlob(env, file) {
  const object = await env.KRILL_UPLOADS.get(file.key);
  if (!object) throw new Error(`Missing uploaded file: ${file.fileName || file.key}`);
  return object.blob();
}

async function readResult(env, job) {
  if (job.resultInline !== undefined) return job.resultInline;
  if (!job.resultKey) return null;
  const object = await env.KRILL_UPLOADS.get(job.resultKey);
  if (!object) throw new Error("Job result object is missing");
  return JSON.parse(await object.text());
}

async function cleanupInputObjects(env, job) {
  const keys = [
    ...(job.files || []).map((file) => file.key),
    job.maskFile && job.maskFile.key,
  ].filter(Boolean);

  await deleteR2Keys(env, keys);
}

async function cleanupResultObject(env, job) {
  if (!job.resultKey) return;

  try {
    const result = await readResult(env, job);
    await env.KRILL_UPLOADS.delete(job.resultKey);
    await saveJob(env, {
      ...job,
      resultKey: undefined,
      resultInline: result,
      resultConsumedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Failed to cleanup Krill result object", job.jobId, error);
  }
}

async function deleteR2Keys(env, keys) {
  await Promise.all(
    keys.map(async (key) => {
      try {
        await env.KRILL_UPLOADS.delete(key);
      } catch (error) {
        console.error("Failed to delete R2 object", key, error);
      }
    }),
  );
}

async function readPayload(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.toLowerCase().startsWith("image/")) {
    return {
      data: [
        {
          b64_json: arrayBufferToBase64(await response.arrayBuffer()),
          output_format: mimeToOutputFormat(contentType),
        },
      ],
    };
  }

  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return normalizeImageString(text) || text;
  }
}

function normalizeImagePayload(payload) {
  if (hasUsableImagePayload(payload)) return payload;

  const imageItems = collectImageItems(payload);
  if (imageItems.length > 0) {
    return { data: imageItems };
  }

  return payload;
}

function hasUsableImagePayload(payload) {
  return collectImageItems(payload, { firstOnly: true }).length > 0;
}

function collectImageItems(value, options = {}, state = { seen: new WeakSet(), depth: 0 }) {
  if (state.depth > 8 || value == null) return [];

  const imageString = typeof value === "string" ? normalizeImageString(value) : null;
  if (imageString) return [imageString];

  if (Array.isArray(value)) {
    const items = [];
    for (const item of value) {
      items.push(...collectImageItems(item, options, { ...state, depth: state.depth + 1 }));
      if (options.firstOnly && items.length > 0) break;
    }
    return items;
  }

  if (!isPlainObject(value)) return [];
  if (state.seen.has(value)) return [];
  state.seen.add(value);

  const direct = normalizeImageRecord(value);
  if (direct) return [direct];

  const childKeys = [
    "data",
    "output",
    "content",
    "images",
    "image",
    "result",
    "response",
    "items",
    "artifacts",
    "generations",
  ];
  const items = [];
  for (const key of childKeys) {
    if (!(key in value)) continue;
    items.push(...collectImageItems(value[key], options, { ...state, depth: state.depth + 1 }));
    if (options.firstOnly && items.length > 0) break;
  }
  return items;
}

function normalizeImageRecord(record) {
  const b64 = firstStringField(record, [
    "b64_json",
    "base64",
    "image_base64",
    "imageBase64",
    "imageData",
  ]);
  if (b64) {
    const normalized = normalizeImageString(b64);
    if (normalized) return normalized;
    if (looksLikeBase64Image(b64)) {
      return { b64_json: stripDataUrlPrefix(b64), output_format: "png" };
    }
  }

  const url = firstStringField(record, ["url", "image_url", "imageUrl"]);
  if (url) {
    const normalized = normalizeImageString(url);
    if (normalized) return normalized;
  }

  const result = firstStringField(record, ["result"]);
  if (result) {
    const normalized = normalizeImageString(result);
    if (normalized) return normalized;
    if (looksLikeBase64Image(result)) {
      return { b64_json: stripDataUrlPrefix(result), output_format: "png" };
    }
  }

  return null;
}

function normalizeImageString(value) {
  const trimmed = value.trim();
  if (/^data:image\//i.test(trimmed)) {
    return { image_url: trimmed };
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return { url: trimmed };
  }
  if (looksLikeBase64Image(trimmed)) {
    return { b64_json: stripDataUrlPrefix(trimmed), output_format: "png" };
  }
  return null;
}

function firstStringField(record, fieldNames) {
  for (const fieldName of fieldNames) {
    const value = record[fieldName];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function looksLikeBase64Image(value) {
  const base64 = stripDataUrlPrefix(value).replace(/\s+/g, "");
  return base64.length > 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(base64);
}

function stripDataUrlPrefix(value) {
  return value.replace(/^data:[^,]+,/i, "").trim();
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function mimeToOutputFormat(contentType) {
  if (/image\/jpe?g/i.test(contentType)) return "jpeg";
  if (/image\/webp/i.test(contentType)) return "webp";
  return "png";
}

function summarizePayload(payload) {
  if (payload == null) return undefined;
  if (typeof payload === "string") {
    return payload.length > 500 ? `${payload.slice(0, 500)}...` : payload;
  }
  try {
    const text = JSON.stringify(payload);
    return text.length > 1000 ? `${text.slice(0, 1000)}...` : payload;
  } catch {
    return "[unserializable payload]";
  }
}

function stringField(form, name) {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function filesField(form, name) {
  return form.getAll(name).filter((value) => isFileLike(value) && value.size > 0);
}

function firstFileField(form, name) {
  return filesField(form, name)[0] || null;
}

function isFileLike(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.arrayBuffer === "function" &&
    typeof value.name === "string"
  );
}

function resolveIncomingAuth(request, env) {
  if (env.KRILL_API_KEY) return `Bearer ${env.KRILL_API_KEY}`;
  return request.headers.get("Authorization") || "";
}

function normalizeSize(value) {
  if (!value || value === "auto") return "1024x1024";
  return value;
}

function normalizeQuality(value) {
  const quality = (value || "medium").toLowerCase();
  if (quality === "low" || quality === "medium" || quality === "high") return quality;
  return "medium";
}

function extensionForType(type) {
  if (type === "image/jpeg") return ".jpg";
  if (type === "image/webp") return ".webp";
  if (type === "image/gif") return ".gif";
  return ".png";
}

function safeFileName(name, fallback) {
  const base = String(name || "")
    .split(/[\\/]/)
    .pop()
    .replace(/[^\w.()+ -]+/g, "_")
    .trim();
  return base || fallback;
}

function errorMessage(error) {
  return String((error && error.message) || error);
}

function extractPayloadMessage(payload) {
  if (!payload) return "";
  if (typeof payload === "string") return payload;
  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.error === "string") return payload.error;
  if (payload.error && typeof payload.error.message === "string") return payload.error.message;
  return "";
}
