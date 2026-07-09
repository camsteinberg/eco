# Security Policy

We take the security of Eco and the people who use it seriously. Thank you for helping
keep it safe.

## Supported versions

Eco ships from the `main` branch, which is what runs at
[econetwork.ai](https://econetwork.ai). Security fixes land on `main`; there are no
separately maintained release branches. Please report issues against the current `main`.

## Reporting a vulnerability

**Please report vulnerabilities privately — not in a public issue.** There are two ways:

1. **GitHub private vulnerability reporting** (preferred): go to the repository's
   **Security** tab and choose **Report a vulnerability**. This opens a private advisory
   visible only to the maintainers and you.
2. **Email:** [security@econetwork.ai](mailto:security@econetwork.ai).

Please include enough detail for us to reproduce: what the issue is, the steps or
proof-of-concept to trigger it, the impact you believe it has, and any relevant
environment details (browser, OS, model in use if it's on-device related).

## What to expect

We'll acknowledge your report within **72 hours** and give you an honest, best-effort
assessment and timeline as we investigate. Eco is a small project, so we can't promise a
formal SLA beyond that, but we'll keep you informed and credit you if you'd like once a
fix ships.

## Please don't

- Don't open a **public** GitHub issue for a suspected vulnerability — use the private
  channels above.
- Don't test against **production accounts other than your own** on econetwork.ai. Use a
  test account you control, and don't attempt to access, modify, or exfiltrate other
  users' data.
- Don't run denial-of-service, spam, or automated high-volume attacks against the
  production service.

## Scope

This policy covers the deployed service at **econetwork.ai** and the code in this
repository. Because Eco's chat is local-first — inference runs in your own browser — much
of the interesting surface is client-side; findings there are just as welcome as
server-side ones in the auth and billing gateway.
