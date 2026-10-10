# Changelog

## [0.14.0](https://github.com/nicholls73/openbrain/compare/v0.13.0...v0.14.0) (2026-10-10)


### Features

* deliver complete memories within a shared context budget ([#187](https://github.com/nicholls73/openbrain/issues/187)) ([89eb4a4](https://github.com/nicholls73/openbrain/commit/89eb4a4f8302c3b78cedd97a50deda89c3981f20))
* guide agents to link related memories ([#178](https://github.com/nicholls73/openbrain/issues/178)) ([e4efb8d](https://github.com/nicholls73/openbrain/commit/e4efb8dadedd268638bc1d4f5ae5ed90adb8310f))
* retrieve relevant context through memory links ([#188](https://github.com/nicholls73/openbrain/issues/188)) ([114c470](https://github.com/nicholls73/openbrain/commit/114c47023ba166243a3d15c28107054976a8d7d2))


### Bug Fixes

* **deps-dev:** bump @biomejs/biome from 2.5.14 to 2.5.15 ([#180](https://github.com/nicholls73/openbrain/issues/180)) ([306ec2b](https://github.com/nicholls73/openbrain/commit/306ec2b18e0b80a9758259816843d3ed7cafecc6))
* **deps-dev:** bump @types/node from 26.6.3 to 26.6.4 ([#181](https://github.com/nicholls73/openbrain/issues/181)) ([f4aa08f](https://github.com/nicholls73/openbrain/commit/f4aa08f6416cecd61380b751f550a98d120a4029))
* **deps-dev:** bump vitest from 5.0.2 to 5.0.3 ([#183](https://github.com/nicholls73/openbrain/issues/183)) ([a7b9917](https://github.com/nicholls73/openbrain/commit/a7b99175e39b3a8d88ac324f87ba8300582311f9))
* **deps:** bump @modelcontextprotocol/sdk from 1.30.1 to 1.32.0 ([#182](https://github.com/nicholls73/openbrain/issues/182)) ([057b94d](https://github.com/nicholls73/openbrain/commit/057b94dd6e55474200410d2e04f775ea773fe717))

## [0.13.0](https://github.com/nicholls73/openbrain/compare/v0.12.1...v0.13.0) (2026-10-03)


### Features

* expose explicit memory relationships as Obsidian links ([#173](https://github.com/nicholls73/openbrain/issues/173)) ([8d71dde](https://github.com/nicholls73/openbrain/commit/8d71dde9b8b4f7b8a408b3af5f0725d2caf717c2))


### Bug Fixes

* clarify confidence required for automatic recall ([#172](https://github.com/nicholls73/openbrain/issues/172)) ([a2ed286](https://github.com/nicholls73/openbrain/commit/a2ed28659a4b47dcce968d08966403f9ed46071d))
* diagnose degraded hooks and stale agent installations ([#174](https://github.com/nicholls73/openbrain/issues/174)) ([19569d9](https://github.com/nicholls73/openbrain/commit/19569d9bf6a1f472eafad9e7eb38ea42f5c1e00d))
* preserve working CLI during failed installs ([#171](https://github.com/nicholls73/openbrain/issues/171)) ([a0c5c24](https://github.com/nicholls73/openbrain/commit/a0c5c24a2ff826edf2a8cf86e3ab73febfd07077))
* refresh configured agent instructions after updates ([#175](https://github.com/nicholls73/openbrain/issues/175)) ([39d07ca](https://github.com/nicholls73/openbrain/commit/39d07ca76aebd98257c746b09b91707cce56f81e))

## [0.12.1](https://github.com/nicholls73/openbrain/compare/v0.12.0...v0.12.1) (2026-10-02)


### Bug Fixes

* restore Codex memory recording guidance ([#164](https://github.com/nicholls73/openbrain/issues/164)) ([07d3e3d](https://github.com/nicholls73/openbrain/commit/07d3e3d3c3477da08545a9c2f932e3db7c6c7bb6))

## [0.12.0](https://github.com/nicholls73/openbrain/compare/v0.11.0...v0.12.0) (2026-09-29)


### Features

* add Obsidian vault root layout ([#159](https://github.com/nicholls73/openbrain/issues/159)) ([5d7ed6e](https://github.com/nicholls73/openbrain/commit/5d7ed6e8d2fbdd777449f1938e44b8dd9b5a420b))


### Bug Fixes

* **deps-dev:** bump @types/node from 26.6.2 to 26.6.3 ([572e6ac](https://github.com/nicholls73/openbrain/commit/572e6acafc83a26e7e6528f1847da550f5840d70))
* **deps-dev:** bump vitest from 5.0.1 to 5.0.2 ([#162](https://github.com/nicholls73/openbrain/issues/162)) ([f69f352](https://github.com/nicholls73/openbrain/commit/f69f3522c39a2add35b6742afcaf88e8260277ed))
* **deps:** bump @modelcontextprotocol/sdk from 1.30.0 to 1.30.1 ([#161](https://github.com/nicholls73/openbrain/issues/161)) ([8bcd202](https://github.com/nicholls73/openbrain/commit/8bcd202ad9e928fcca4b7051c36fea778cdad030))

## [0.11.0](https://github.com/nicholls73/openbrain/compare/v0.10.0...v0.11.0) (2026-09-29)


### Features

* manage Obsidian Sync in background ([#157](https://github.com/nicholls73/openbrain/issues/157)) ([add264b](https://github.com/nicholls73/openbrain/commit/add264bd7ef90b836283208a18338ac171feeb0d))

## [0.10.0](https://github.com/nicholls73/openbrain/compare/v0.9.1...v0.10.0) (2026-09-25)


### Features

* add account-based Obsidian Sync storage ([#156](https://github.com/nicholls73/openbrain/issues/156)) ([df801e9](https://github.com/nicholls73/openbrain/commit/df801e9e3b1674daa480fe9fee39a9f41586829e))
* add per-brain Obsidian storage ([#154](https://github.com/nicholls73/openbrain/issues/154)) ([d6d50c6](https://github.com/nicholls73/openbrain/commit/d6d50c6607b1a8c977da4d77fbce98e1d2c6298a))

## [0.9.1](https://github.com/nicholls73/openbrain/compare/v0.9.0...v0.9.1) (2026-09-24)


### Bug Fixes

* keep update confirmation prompt open ([#152](https://github.com/nicholls73/openbrain/issues/152)) ([380e725](https://github.com/nicholls73/openbrain/commit/380e725b2a13f684d787ffc8cee479e39596de03))

## [0.9.0](https://github.com/nicholls73/openbrain/compare/v0.8.2...v0.9.0) (2026-09-24)


### Features

* make Codex memory retrieval hook-first ([#150](https://github.com/nicholls73/openbrain/issues/150)) ([ba966c9](https://github.com/nicholls73/openbrain/commit/ba966c98213caaf85a6028886c3a501824be492b))


### Bug Fixes

* **deps-dev:** bump @biomejs/biome from 2.5.11 to 2.5.14 ([#147](https://github.com/nicholls73/openbrain/issues/147)) ([9a127f8](https://github.com/nicholls73/openbrain/commit/9a127f8415eaa6df7ff6fc552c9dc25a067250b0))
* **deps-dev:** bump @types/node from 26.4.1 to 26.6.2 ([#145](https://github.com/nicholls73/openbrain/issues/145)) ([e7e599d](https://github.com/nicholls73/openbrain/commit/e7e599d78415b32993056db8073555aefba86382))
* **deps-dev:** bump vitest from 4.1.11 to 5.0.1 ([#148](https://github.com/nicholls73/openbrain/issues/148)) ([b3e0b75](https://github.com/nicholls73/openbrain/commit/b3e0b751886cd69fd258e9c3da2ffc6c10ef019f))
* **deps:** bump @huggingface/transformers from 4.2.0 to 4.3.0 ([#146](https://github.com/nicholls73/openbrain/issues/146)) ([de8990a](https://github.com/nicholls73/openbrain/commit/de8990a260051cee05fe44b502c65354ecc82328))
* **deps:** bump zod from 4.5.4 to 4.6.5 ([#144](https://github.com/nicholls73/openbrain/issues/144)) ([b1b871a](https://github.com/nicholls73/openbrain/commit/b1b871a9590690bf7a1cda5b34f7ca5ceb560c4f))

## [0.8.2](https://github.com/nicholls73/openbrain/compare/v0.8.1...v0.8.2) (2026-09-05)


### Bug Fixes

* **deps-dev:** bump @types/better-sqlite3 from 7.6.13 to 9.6.0 ([#134](https://github.com/nicholls73/openbrain/issues/134)) ([aae2576](https://github.com/nicholls73/openbrain/commit/aae2576f415a88c4548d96b3318a61d0236ac5f2))
* **deps:** bump zod from 4.5.2 to 4.5.4 ([#133](https://github.com/nicholls73/openbrain/issues/133)) ([093b7b0](https://github.com/nicholls73/openbrain/commit/093b7b0d14fb385a1e029d85e7399d5795b2a294))

## [0.8.1](https://github.com/nicholls73/openbrain/compare/v0.8.0...v0.8.1) (2026-09-05)


### Bug Fixes

* release Dependabot chores as patches ([#136](https://github.com/nicholls73/openbrain/issues/136)) ([0736af9](https://github.com/nicholls73/openbrain/commit/0736af93fd713015e6565e665ad9e02820c5d2fa))
* release dependency updates as patches ([#132](https://github.com/nicholls73/openbrain/issues/132)) ([03296f3](https://github.com/nicholls73/openbrain/commit/03296f3a8f27c0077ed673c3f33182635b690e8d))

## [0.8.0](https://github.com/nicholls73/openbrain/compare/v0.7.3...v0.8.0) (2026-08-20)


### Features

* add Codex prompt memory hook ([#117](https://github.com/nicholls73/openbrain/issues/117)) ([182ffb7](https://github.com/nicholls73/openbrain/commit/182ffb7c7449dba6c4c7f0dce49039c426f92c74))
* discover recurring episode patterns ([#116](https://github.com/nicholls73/openbrain/issues/116)) ([ef0b668](https://github.com/nicholls73/openbrain/commit/ef0b6682e4100e5d92b64b5839b2210894fcfd40))


### Bug Fixes

* keep successful searches off stderr ([#114](https://github.com/nicholls73/openbrain/issues/114)) ([0616b68](https://github.com/nicholls73/openbrain/commit/0616b689d5e3c18cb8b472e905058a8584285169))

## [0.7.3](https://github.com/nicholls73/openbrain/compare/v0.7.2...v0.7.3) (2026-08-03)


### Bug Fixes

* await y/N prompts so readline is not closed before input ([#112](https://github.com/nicholls73/openbrain/issues/112)) ([9445f43](https://github.com/nicholls73/openbrain/commit/9445f431d642ff3ec6caa83028530718a3a38988))

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
