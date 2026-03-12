# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-03-13

### Added

- `wrap()` — type-safe RPC proxy for Web Workers with `CancellablePromise`
- `expose()` — worker-side API registration with automatic `AbortSignal` injection
- `pool()` — worker pool with least-busy dispatch and optional respawn on crash
- `transfer()` — zero-copy transferable support for both main and worker threads
- Streaming via async generators, surfaced as `AsyncIterableIterator`
- Per-call `.timeout(ms)` override and default timeout via `WrapOptions`
- Stream idle timeout (reuses the timeout value for inactivity detection)
- `.abort(reason?)` and `.signal(AbortSignal)` for cooperative cancellation
- `dispose()` and `Symbol.dispose` (`using` syntax) for cleanup
- Dual ESM/CJS build with full TypeScript declarations and source maps
- Unit tests (110 tests) and E2E browser tests (21 tests via Playwright)
- CI pipeline (GitHub Actions) with lint, format check, typecheck, coverage, and E2E

[0.1.0]: https://github.com/frauschert/thread-weaver/releases/tag/v0.1.0
