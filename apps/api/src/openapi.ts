// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

export const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'Eco API',
    version: '0.1.0',
    description:
      'Eco API gateway for the local-first AI chat app. Covers account auth and sessions (Better Auth) only. Chat inference runs entirely on the user’s own device — the API does not perform or proxy inference.',
    license: {
      name: 'AGPL-3.0-or-later',
      url: 'https://www.gnu.org/licenses/agpl-3.0.html',
    },
  },
  servers: [{ url: '/', description: 'Current server' }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http' as const,
        scheme: 'bearer',
        description: 'API key or session token',
      },
    },
    schemas: {
      HealthResponse: {
        type: 'object' as const,
        required: ['status', 'version', 'uptime'],
        properties: {
          status: { type: 'string' as const, enum: ['ok'] },
          version: { type: 'string' as const },
          uptime: {
            type: 'integer' as const,
            description: 'Uptime in seconds',
          },
        },
      },
      ErrorResponse: {
        type: 'object' as const,
        required: ['error'],
        properties: {
          error: {
            type: 'object' as const,
            required: ['message', 'type'],
            properties: {
              message: { type: 'string' as const },
              type: {
                type: 'string' as const,
                enum: [
                  'invalid_request_error',
                  'validation_error',
                  'authentication_error',
                  'rate_limit_error',
                  'rate_limited',
                  'search_unavailable',
                  'server_error',
                  'not_found_error',
                ],
              },
            },
          },
        },
      },
    },
    headers: {
      'X-RateLimit-Limit': {
        description: 'Maximum requests allowed in the current window',
        schema: { type: 'integer' as const },
      },
      'X-RateLimit-Remaining': {
        description: 'Remaining requests in the current window',
        schema: { type: 'integer' as const },
      },
      'X-Request-Id': {
        description: 'Unique request identifier for tracing',
        schema: { type: 'string' as const, format: 'uuid' },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/health': {
      get: {
        operationId: 'healthCheck',
        summary: 'Health check',
        description: 'Returns server health status including uptime.',
        tags: ['System'],
        security: [],
        responses: {
          '200': {
            description: 'Server is healthy',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HealthResponse' },
              },
            },
          },
        },
      },
    },
    '/v1/feedback': {
      post: {
        operationId: 'submitFeedback',
        summary: 'Submit in-app feedback',
        description:
          'Anonymous feedback submission. Stores only the typed message and an optional, explicitly opt-in device summary — no user id, IP, or headers. Tightly rate limited per IP.',
        tags: ['Feedback'],
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object' as const,
                required: ['message'],
                properties: {
                  message: {
                    type: 'string' as const,
                    maxLength: 4000,
                    description: 'The feedback text as typed by the person.',
                  },
                  deviceSummary: {
                    type: 'string' as const,
                    maxLength: 1000,
                    description:
                      'Optional opt-in device summary (browser, device class, active model), shown to the person verbatim before sending.',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Feedback stored',
            content: {
              'application/json': {
                schema: {
                  type: 'object' as const,
                  required: ['ok'],
                  properties: { ok: { type: 'boolean' as const, enum: [true] } },
                },
              },
            },
          },
          '400': {
            description: 'Invalid JSON or failed validation',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          '429': {
            description: 'Rate limited',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/v1/search': {
      post: {
        operationId: 'relayWebSearch',
        summary: 'Relay one web-search query',
        description:
          'Relays a single query to Eco\u2019s self-hosted SearXNG instance and returns at most three snippets. No auth, no cookie, no user id \u2014 the browser asks Eco so the search engine never sees the person\u2019s IP. The query is held only for the lifetime of the request: it is never logged, stored, or attached to an account. Upstream trouble (timeout, dead instance, non-JSON, zero hits) returns 200 with an empty `results` array rather than a 5xx.',
        tags: ['Search'],
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object' as const,
                required: ['q'],
                properties: {
                  q: {
                    type: 'string' as const,
                    minLength: 2,
                    maxLength: 200,
                    description: 'The search query, trimmed before validation.',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Search results (possibly empty)',
            content: {
              'application/json': {
                schema: {
                  type: 'object' as const,
                  required: ['fetchedAt', 'results'],
                  properties: {
                    fetchedAt: { type: 'string' as const, format: 'date-time' },
                    results: {
                      type: 'array' as const,
                      maxItems: 3,
                      items: {
                        type: 'object' as const,
                        required: ['title', 'url', 'snippet', 'domain'],
                        properties: {
                          title: { type: 'string' as const, maxLength: 100 },
                          url: { type: 'string' as const, format: 'uri' },
                          snippet: { type: 'string' as const, maxLength: 220 },
                          domain: {
                            type: 'string' as const,
                            description: 'Hostname of the result URL, without a leading `www.`',
                          },
                          published: {
                            type: 'string' as const,
                            description:
                              'Publication date as reported upstream. Absent when upstream did not report one.',
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': {
            description: 'Invalid JSON or a query outside 2\u2013200 characters',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          '403': {
            description: 'Origin not on the allowlist',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          '429': {
            description: 'Per-IP rate limit exceeded',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          '503': {
            description: 'Global daily search ceiling reached',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
  },
} as const
