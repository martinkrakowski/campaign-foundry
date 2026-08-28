# Architecture

Style: **hexagonal**

> An HITL orchestrator for deterministic creative generation and automated brand compliance.

## Universal Boundary Rules

These hold regardless of style and are enforced in review:

- **Dependencies point inward / downward.** Business logic never imports
  framework, transport, or persistence code. The edges depend on the core, not
  the other way round.
- **No circular dependencies** between modules.
- **I/O lives at the edges.** Network, filesystem, database, and clock access
  are isolated behind a thin boundary so the core stays pure and testable.
- **One reason to change per module.** If a file mixes business rules with
  wiring, split it.

## Layer Conventions

The naming below is the convention for the **hexagonal** style. If
your style differs, keep the *intent* (clear boundaries, inward dependencies)
even if the folder names change.

- **hexagonal** — `domain/` (entities, value objects, pure logic), `application/`
  (use cases + `*.port.ts` interfaces), `infrastructure/` (`*.adapter.ts`
  implementations). Domain imports nothing outward; adapters implement ports.
- **layered** — `presentation/` → `application/` → `domain/` → `infrastructure/`,
  each layer importing only the one below it.
- **feature-based** — top-level `features/<name>/` slices, each self-contained;
  shared code lives in a `shared/` module that features may import but that
  never imports a feature.
- **monolith** — keep modules cohesive and dependencies explicit; resist a
  single god-module by grouping by responsibility.

## Adding Code

1. Identify the layer the change belongs to.
2. If it crosses a boundary, define/extend a port (interface) rather than
   reaching across directly.
3. Put the test next to the module (see `.agents/testing.md`).

## Storage Ports & Cloud Storage Boundary (API)

Briefs and assets in `apps/api` are isolated behind hexagonal storage ports defined in
`apps/api/server/lib/ports/`:

- **`BriefStorePort`** (`brief-store.port.ts`): abstracts loading, listing, creating,
  rewriting, replacing, and revision hashing of campaign briefs. Brief IDs serve as
  logical store keys with no leaked filesystem or filename semantics.
- **`AssetStorePort`** (`asset-store.port.ts`): abstracts writing, listing, and
  copying (`copyAssets(from, to)`) of campaign assets (logos, background images).

No `node:fs`, path joining, or `process.cwd()` may leak through route handlers or port
interfaces into callers.

### S3 Adapter Shape

When transitioning from the local filesystem (`FsBriefStore`, `FsAssetStore`) to cloud
storage (e.g. AWS S3, Cloudflare R2, GCS), adapters implement the exact same port interfaces:

```ts
export class S3BriefStore implements BriefStorePort {
  constructor(private readonly s3: S3Client, private readonly bucket: string, private readonly prefix = "briefs/") {}

  // Maps brief.id -> s3://bucket/briefs/<id>.yaml
  // - listBriefs: ListObjectsV2Command + GetObjectCommand; ETag or SHA-256 digest as revision
  // - createBrief: PutObjectCommand with If-None-Match: "*" (exclusive create)
  // - rewriteBrief / replaceBrief: PutObjectCommand with If-Match for revision concurrency
  // - withBriefLock: distributed lease (e.g. DynamoDB / Redis lock) or S3 conditional write
}

export class S3AssetStore implements AssetStorePort {
  constructor(private readonly s3: S3Client, private readonly bucket: string, private readonly prefix = "assets/inputs/") {}

  // Maps (briefId, name) -> s3://bucket/assets/inputs/<briefId>/<name>
  // - writeAsset: PutObjectCommand with If-None-Match: "*"
  // - listAssets: ListObjectsV2Command (Prefix: assets/inputs/<briefId>/) + metadata/presigned URL or data URL
  // - copyAssets: ListObjectsV2Command + CopyObjectCommand (fromPrefix -> toPrefix)
}
```

