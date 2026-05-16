import { describe, expect, it } from 'vitest'

import { buildApiErrorFromResponse } from '../debug'

describe('buildApiErrorFromResponse', () => {
  it('summarizes Cloudflare HTML error pages', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>bactdt.workers.dev | 502: Bad gateway</title>
        </head>
        <body>
          <div id="cf-error-details">
            <span class="inline-block">Bad gateway</span>
            <span class="code-label">Error code 502</span>
            <div id="cf-host-status">
              <span class="md:block w-full truncate">newimage.9z1.me</span>
              <h3>Host</h3>
            </div>
            <a href="https://www.cloudflare.com/5xx-error-landing">Cloudflare</a>
          </div>
        </body>
      </html>
    `

    const error = await buildApiErrorFromResponse(
      new Response(html, {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    )

    expect(error.message).toBe(
      '上游站点返回 Cloudflare 502 Bad gateway（Host newimage.9z1.me）。请稍后重试，或切换到可用的供应商/中转站。',
    )
    expect(error.details).toMatchObject({
      cloudflare: {
        code: '502',
        title: 'Bad gateway',
        host: 'newimage.9z1.me',
      },
    })
  })
})
