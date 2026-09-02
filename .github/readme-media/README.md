# Public README demo media

These assets illustrate the public Docker Demo only. They are not customer-console screenshots and do not contain real accounts, production credentials, private hosts, or customer data.

## Assets

- `bailinghub-public-demo.zh-CN.gif`: 960 x 600, six frames, about 15 seconds, Chinese captions.
- `bailinghub-public-demo.en.gif`: 960 x 600, six frames, about 15 seconds, English captions over the same public demo UI.

SHA-256:

```text
cc63618f560007d65b5ef6772e308649a5797ff9749e7be3c47f9985d4c764f1  bailinghub-public-demo.zh-CN.gif
13e2c0a2d0cc4263db97077529d197c0f3b511b9dee2a754147c9b4e2652a5d5  bailinghub-public-demo.en.gif
```

The walkthrough uses the deterministic public fixture `SO-1001` and shows:

1. the order inside the sample business application;
2. a natural-language refund request stopped by high-risk governance;
3. frozen arguments delivered as a business approval intent;
4. approved execution writing the sample refund request; and
5. the resulting BailingHub Trace.

Volatile job, worker, session, and generated refund identifiers are hidden or replaced with public demo labels. The semantic request id remains `public-demo-video-refund-v1` so the Trace lookup is understandable.

## Regeneration boundary

Regenerate from a clean checkout and an isolated Docker Compose project. Capture the public demo at 1280 x 720, compose the six frames at 960 x 600, keep each GIF below 1 MiB, and verify both README files render correctly. The media lives under `.github/`, which is excluded from the current npm package; confirm this again with `npm pack --dry-run` before merging.

Do not capture a self-use instance, commercial environment, real business integration, browser profile, API key, token, customer record, or local absolute path.
