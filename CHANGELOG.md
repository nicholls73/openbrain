# Changelog

## [0.7.2](https://github.com/nicholls73/openbrain/compare/v0.7.1...v0.7.2) (2026-08-01)


### Bug Fixes

* expose the CLI package version ([#110](https://github.com/nicholls73/openbrain/issues/110)) ([d9a1eb0](https://github.com/nicholls73/openbrain/commit/d9a1eb03532b192bb3b9e4bf3d0e3559db5594f5))

## [0.7.1](https://github.com/nicholls73/openbrain/compare/v0.7.0...v0.7.1) (2026-07-31)


### Bug Fixes

* delete FTS rows with a single DELETE statement ([#98](https://github.com/nicholls73/openbrain/issues/98)) ([15e58e9](https://github.com/nicholls73/openbrain/commit/15e58e910975a14d9176b124c72e7a506f6eb35d)), closes [#94](https://github.com/nicholls73/openbrain/issues/94)
* filter irrelevant semantic search results ([#92](https://github.com/nicholls73/openbrain/issues/92)) ([0affeaa](https://github.com/nicholls73/openbrain/commit/0affeaab6b9393c8b8cec26d09ae5460d84ae277))
* point SQLite rebuild at the real install directory ([#103](https://github.com/nicholls73/openbrain/issues/103)) ([019cfff](https://github.com/nicholls73/openbrain/commit/019cfffab17b2a4dd73dd28fb41a63be216dcc0f))
* read release version from candidate ([#109](https://github.com/nicholls73/openbrain/issues/109)) ([0d44652](https://github.com/nicholls73/openbrain/commit/0d44652c9e3d455230644dc4004ca5b1775778e9))
* refuse to overwrite malformed Claude settings values ([#100](https://github.com/nicholls73/openbrain/issues/100)) ([3ddcbaa](https://github.com/nicholls73/openbrain/commit/3ddcbaa864dcb7c52348de724fbe22839be87124))
* report missing option value in memory search args ([#99](https://github.com/nicholls73/openbrain/issues/99)) ([42d89b0](https://github.com/nicholls73/openbrain/commit/42d89b0d78726699d93662b69e29d27d9e267967))
* report release checks to branch protection ([#107](https://github.com/nicholls73/openbrain/issues/107)) ([709020d](https://github.com/nicholls73/openbrain/commit/709020d2c701fa104a3869c1607dc7094a48056e))
* resolve home directory via os.homedir in expandHome ([#97](https://github.com/nicholls73/openbrain/issues/97)) ([954d33c](https://github.com/nicholls73/openbrain/commit/954d33cf4a0624f2b1e69d4c5cdcf7a9ccdef070))
* restore automatic release approvals ([#108](https://github.com/nicholls73/openbrain/issues/108)) ([16cb34f](https://github.com/nicholls73/openbrain/commit/16cb34ff4e1f0e9f10fe0941e679e3e7458852b9))
* run release checks before approval ([#104](https://github.com/nicholls73/openbrain/issues/104)) ([b0e9559](https://github.com/nicholls73/openbrain/commit/b0e95595eb546962459f864355160b4d87a99c37))

## [0.7.0](https://github.com/nicholls73/openbrain/compare/v0.6.1...v0.7.0) (2026-07-22)


### Features

* add explicit update command ([#84](https://github.com/nicholls73/openbrain/issues/84)) ([953427d](https://github.com/nicholls73/openbrain/commit/953427d5c7bef8954fbd1e1151744157300518d2))
* add MCP server exposing memory operations ([#78](https://github.com/nicholls73/openbrain/issues/78)) ([a9d6c58](https://github.com/nicholls73/openbrain/commit/a9d6c58d8dc843d1c3d70f03a54b7f1fbc533efb))
* doctor: report per-agent enforcement strength and warn on stale brains ([#75](https://github.com/nicholls73/openbrain/issues/75)) ([cd932f9](https://github.com/nicholls73/openbrain/commit/cd932f9f5a750efd830ec2164c6bc8d60653386a))
* doctor: warn on aged review backlog and duplicate density ([#76](https://github.com/nicholls73/openbrain/issues/76)) ([4e23926](https://github.com/nicholls73/openbrain/commit/4e23926939b1bc189410669d293bd2d35364e778))

## [0.6.1](https://github.com/nicholls73/openbrain/compare/v0.6.0...v0.6.1) (2026-07-22)


### Bug Fixes

* prevent competing Claude memory stores ([#80](https://github.com/nicholls73/openbrain/issues/80)) ([c856f16](https://github.com/nicholls73/openbrain/commit/c856f16d58e28af8cd404392351e05443f205fe6))

## [0.6.0](https://github.com/nicholls73/openbrain/compare/v0.5.0...v0.6.0) (2026-07-21)


### Features

* auto-detect installed agents in setup instead of asking ([#55](https://github.com/nicholls73/openbrain/issues/55)) ([9a9c874](https://github.com/nicholls73/openbrain/commit/9a9c8742f5c996f52afc1c09b73a20d2e0192e79)), closes [#54](https://github.com/nicholls73/openbrain/issues/54)
* automate releases with release PRs ([d955a8b](https://github.com/nicholls73/openbrain/commit/d955a8bab20df7ebc486e54373fcc599f2fc44b0))
* publish npm package after main CI ([b269709](https://github.com/nicholls73/openbrain/commit/b269709b9e48ddcc48efb4a03c103dff3c09ae9a))


### Bug Fixes

* explain sandbox permission failures and guide agents to request elevation ([#67](https://github.com/nicholls73/openbrain/issues/67)) ([45e0b27](https://github.com/nicholls73/openbrain/commit/45e0b27b9d70f4cc534d498ceb036bf059bd40f8)), closes [#61](https://github.com/nicholls73/openbrain/issues/61)
* open the SQLite index read-only for memory search, list, and show ([#66](https://github.com/nicholls73/openbrain/issues/66)) ([7a62253](https://github.com/nicholls73/openbrain/commit/7a62253b93e5d13aaf0c36a61ba828ff048fe41d))
* protect active releases from cancellation ([830e63d](https://github.com/nicholls73/openbrain/commit/830e63dcbafaa8c986e26d6db39db0e5a7b0375f))
