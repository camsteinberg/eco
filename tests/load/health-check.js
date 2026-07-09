// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const healthDuration = new Trend('health_duration');

export const options = {
  scenarios: {
    health_baseline: {
      executor: 'constant-arrival-rate',
      rate: 1000,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 100,
      maxVUs: 200,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500'],
    errors: ['rate<0.01'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001';

export default function () {
  const res = http.get(`${BASE_URL}/health`);

  check(res, {
    'status is 200': (r) => r.status === 200,
    'body has status ok': (r) => JSON.parse(r.body).status === 'ok',
  }) || errorRate.add(1);

  healthDuration.add(res.timings.duration);
}
