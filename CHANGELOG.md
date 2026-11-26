## [0.13.2](https://github.com/os-factory/otel-hook/compare/v0.13.1...v0.13.2) (2026-11-26)


### Bug Fixes

* claim spool batches with an exclusive claim file, not a rename ([#77](https://github.com/os-factory/otel-hook/issues/77)) ([bfc0a1f](https://github.com/os-factory/otel-hook/commit/bfc0a1fcc311378c392703d06d9f2b8014b3ae94))
* read Codex token usage from the rollout, and never stall a hook on a down collector ([#75](https://github.com/os-factory/otel-hook/issues/75)) ([5fd660c](https://github.com/os-factory/otel-hook/commit/5fd660c7ce31581ca8c4c0284ae45eaf59add611))

## [0.13.1](https://github.com/os-factory/otel-hook/compare/v0.13.0...v0.13.1) (2026-11-26)


### Bug Fixes

* keep session context, spans and spools correct under many concurrent sessions ([#74](https://github.com/os-factory/otel-hook/issues/74)) ([763a842](https://github.com/os-factory/otel-hook/commit/763a8425ec569d9c8f36ec1565671cf6f4993eb6))

# [0.13.0](https://github.com/os-factory/otel-hook/compare/v0.12.0...v0.13.0) (2026-11-26)


### Features

* count Claude Code subagent tokens on the subagent's own generation ([#72](https://github.com/os-factory/otel-hook/issues/72)) ([970f8eb](https://github.com/os-factory/otel-hook/commit/970f8eb4cd42520ed8655dd3f1a042c8060e7fe2)), closes [#68](https://github.com/os-factory/otel-hook/issues/68)

# [0.12.0](https://github.com/os-factory/otel-hook/compare/v0.11.0...v0.12.0) (2026-11-26)


### Features

* stamp session context from a harness-written directory on every record ([#71](https://github.com/os-factory/otel-hook/issues/71)) ([c44febe](https://github.com/os-factory/otel-hook/commit/c44febee1a254b0c7f223d8f7874715ee865d3ac))

# [0.11.0](https://github.com/os-factory/otel-hook/compare/v0.10.0...v0.11.0) (2026-11-25)


### Features

* export hook-derived OpenTelemetry metrics to every destination ([#69](https://github.com/os-factory/otel-hook/issues/69)) ([#70](https://github.com/os-factory/otel-hook/issues/70)) ([f8db3e4](https://github.com/os-factory/otel-hook/commit/f8db3e4a5520018994fc5e16ad64c9a56b41c2f7))

# [0.10.0](https://github.com/os-factory/otel-hook/compare/v0.9.0...v0.10.0) (2026-11-25)


### Features

* **claude:** name the model and sum turn token usage on generations ([#67](https://github.com/os-factory/otel-hook/issues/67)) ([3ac019c](https://github.com/os-factory/otel-hook/commit/3ac019c65acfb7be40f7c4bb9c33ff056c4ca025)), closes [#64](https://github.com/os-factory/otel-hook/issues/64)

# [0.9.0](https://github.com/os-factory/otel-hook/compare/v0.8.0...v0.9.0) (2026-11-24)


### Features

* export to multiple OTLP destinations with a disk spool ([#59](https://github.com/os-factory/otel-hook/issues/59)) ([a8aac09](https://github.com/os-factory/otel-hook/commit/a8aac0903ffaf06b7b2fddb5664efbb788582450)), closes [#54](https://github.com/os-factory/otel-hook/issues/54)

# [0.8.0](https://github.com/os-factory/otel-hook/compare/v0.7.0...v0.8.0) (2026-11-23)


### Features

* **config:** standard OTLP endpoint env vars and profile attribute passthrough ([#53](https://github.com/os-factory/otel-hook/issues/53)) ([a763a33](https://github.com/os-factory/otel-hook/commit/a763a334767bbd104a383a7b0655f20c38852d7a))
* **deps:** move to OpenTelemetry JS 3.x (api 1.10) ([#51](https://github.com/os-factory/otel-hook/issues/51)) ([e39cc4c](https://github.com/os-factory/otel-hook/commit/e39cc4ce9d19c82bb68178de1c992292c1cf8fbe)), closes [os-factory/har#447](https://github.com/os-factory/har/issues/447)

# [0.7.0](https://github.com/os-factory/otel-hook/compare/v0.6.0...v0.7.0) (2026-11-23)


### Features

* **config:** read OTEL_EXPORTER_OTLP_*_HEADERS and accept session.id from the harness ([#52](https://github.com/os-factory/otel-hook/issues/52)) ([0032c32](https://github.com/os-factory/otel-hook/commit/0032c32f9f48546a8ab1c129ee43dec1d31ec37a))

# [0.6.0](https://github.com/os-factory/otel-hook/compare/v0.5.0...v0.6.0) (2026-11-15)


### Features

* name the session's own worktree on its start and prompts ([#43](https://github.com/os-factory/otel-hook/issues/43)) ([dcf1e39](https://github.com/os-factory/otel-hook/commit/dcf1e39e338ee7e2a0be2f4aac3863b914706c77))

# [0.5.0](https://github.com/os-factory/otel-hook/compare/v0.4.1...v0.5.0) (2026-11-15)


### Features

* export the repository and worktree kind of each tool event's target ([#42](https://github.com/os-factory/otel-hook/issues/42)) ([dd94535](https://github.com/os-factory/otel-hook/commit/dd945359063226e6bd36747e39ebf0936714e9de))

## [0.4.1](https://github.com/os-factory/otel-hook/compare/v0.4.0...v0.4.1) (2026-11-13)


### Bug Fixes

* **release:** publish to npm with Trusted Publishing ([#41](https://github.com/os-factory/otel-hook/issues/41)) ([cb0536f](https://github.com/os-factory/otel-hook/commit/cb0536f6bea31c89cc17b736d7f1edd86916f6d8))

# [0.4.0](https://github.com/os-factory/otel-hook/compare/v0.3.0...v0.4.0) (2026-11-12)


### Features

* export the git worktree each tool event targeted ([#40](https://github.com/os-factory/otel-hook/issues/40)) ([905d0fe](https://github.com/os-factory/otel-hook/commit/905d0feb51963c77f0e019d11f88edb2168d3df9))

# [0.3.0](https://github.com/os-factory/otel-hook/compare/v0.2.0...v0.3.0) (2026-08-16)


### Features

* improve Claude print-session trajectory fidelity ([#35](https://github.com/os-factory/otel-hook/issues/35)) ([07b7b0e](https://github.com/os-factory/otel-hook/commit/07b7b0eac4f169e7e5cebf2dd16a2d293f7cb3a6))

# [0.2.0](https://github.com/os-factory/otel-hook/compare/v0.1.3...v0.2.0) (2026-08-14)


### Features

* **claude:** capture final response content ([#34](https://github.com/os-factory/otel-hook/issues/34)) ([d612b8a](https://github.com/os-factory/otel-hook/commit/d612b8ad261f55cde5a586dc13f6873072cb64e6))

## [0.1.3](https://github.com/os-factory/otel-hook/compare/v0.1.2...v0.1.3) (2026-08-10)


### Bug Fixes

* **cli:** accept legacy --cursor/--claude/--codex provider shorthands ([#31](https://github.com/os-factory/otel-hook/issues/31)) ([a04ac7f](https://github.com/os-factory/otel-hook/commit/a04ac7f84b7450adc414a18c8370023b5667e1a1))

## [0.1.2](https://github.com/os-factory/otel-hook/compare/v0.1.1...v0.1.2) (2026-08-02)


### Bug Fixes

* **cursor:** accept session_id fallback for beforeSubmitPrompt attribution ([#33](https://github.com/os-factory/otel-hook/issues/33)) ([7a5fdb4](https://github.com/os-factory/otel-hook/commit/7a5fdb421b3b578ede656ce4c1b5f15bc6dd7bdd))

## [0.1.1](https://github.com/os-factory/otel-hook/compare/v0.1.0...v0.1.1) (2026-07-29)


### Bug Fixes

* **test:** use platform paths in cursor install location assertions ([#29](https://github.com/os-factory/otel-hook/issues/29)) ([e5c07df](https://github.com/os-factory/otel-hook/commit/e5c07df95a948a4a5619d052a37b095affe3dfb5))
