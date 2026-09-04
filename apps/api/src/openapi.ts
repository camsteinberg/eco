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
                  'authentication_error',
                  'rate_limit_error',
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
  },
} as const
