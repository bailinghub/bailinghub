# Third-Party Notices

This document records open-source specifications, runtime components, and JavaScript packages used by BailingHub. It is generated from the repository lockfiles so dependency upgrades cannot silently leave the inventory stale.

Regenerate it with `npm run notices:generate` and verify it with `npm run notices:check`.

## Open Contract

- [Agent Capability Contract (ACC)](https://github.com/agent-capability/agent-capability-contract) is an implementation-neutral capability declaration contract licensed under Apache-2.0. BailingHub adopts ACC and distributes an implementation schema derived from the ACC v1 schema. The applicable ACC attribution is preserved in [NOTICE](NOTICE).

## Container Runtime Components

- BailingHub and its demo business service use the official [Node.js](https://github.com/nodejs/node) 22 Bookworm Slim image as their default container base. Node.js and the Debian packages in that image retain their own licenses and notices.
- The default Docker Compose topology runs [MySQL Community Server](https://www.mysql.com/products/community/) 8.4 as a separate service. The public mirror configured by BailingHub is a redistribution of the upstream MySQL image; operators may replace it through `BAILING_MYSQL_IMAGE`. MySQL Community Server is licensed by its upstream project under GPL terms and is not relicensed as part of BailingHub.

## JavaScript Dependency Inventory

The package license texts and copyright notices remain in the installed package distributions. The table below is an inventory, not a replacement for those upstream license files.

| Distribution | Package | Version | License | Class |
|---|---|---:|---|---|
| Console | [@babel/helper-string-parser](https://www.npmjs.com/package/@babel/helper-string-parser) | 7.29.7 | MIT | runtime |
| Console | [@babel/helper-validator-identifier](https://www.npmjs.com/package/@babel/helper-validator-identifier) | 7.29.7 | MIT | runtime |
| Console | [@babel/parser](https://www.npmjs.com/package/@babel/parser) | 7.29.7 | MIT | runtime |
| Console | [@babel/types](https://www.npmjs.com/package/@babel/types) | 7.29.7 | MIT | runtime |
| Console | [@ctrl/tinycolor](https://www.npmjs.com/package/@ctrl/tinycolor) | 4.2.0 | MIT | runtime |
| Console | [@element-plus/icons-vue](https://www.npmjs.com/package/@element-plus/icons-vue) | 2.3.2 | MIT | runtime |
| Console | [@esbuild/aix-ppc64](https://www.npmjs.com/package/@esbuild/aix-ppc64) | 0.25.12 | MIT | build/test |
| Console | [@esbuild/android-arm](https://www.npmjs.com/package/@esbuild/android-arm) | 0.25.12 | MIT | build/test |
| Console | [@esbuild/android-arm64](https://www.npmjs.com/package/@esbuild/android-arm64) | 0.25.12 | MIT | build/test |
| Console | [@esbuild/android-x64](https://www.npmjs.com/package/@esbuild/android-x64) | 0.25.12 | MIT | build/test |
| Console | [@esbuild/darwin-arm64](https://www.npmjs.com/package/@esbuild/darwin-arm64) | 0.25.12 | MIT | build/test |
| Console | [@esbuild/darwin-x64](https://www.npmjs.com/package/@esbuild/darwin-x64) | 0.25.12 | MIT | build/test |
| Console | [@esbuild/freebsd-arm64](https://www.npmjs.com/package/@esbuild/freebsd-arm64) | 0.25.12 | MIT | build/test |
| Console | [@esbuild/freebsd-x64](https://www.npmjs.com/package/@esbuild/freebsd-x64) | 0.25.12 | MIT | build/test |
| Console | [@esbuild/linux-arm](https://www.npmjs.com/package/@esbuild/linux-arm) | 0.25.12 | MIT | build/test |
| Console | [@esbuild/linux-arm64](https://www.npmjs.com/package/@esbuild/linux-arm64) | 0.25.12 | MIT | build/test |
| Console | [@esbuild/linux-ia32](https://www.npmjs.com/package/@esbuild/linux-ia32) | 0.25.12 | MIT | build/test |
| Console | [@esbuild/linux-loong64](https://www.npmjs.com/package/@esbuild/linux-loong64) | 0.25.12 | MIT | build/test |
| Console | [@esbuild/linux-mips64el](https://www.npmjs.com/package/@esbuild/linux-mips64el) | 0.25.12 | MIT | build/test |
| Console | [@esbuild/linux-ppc64](https://www.npmjs.com/package/@esbuild/linux-ppc64) | 0.25.12 | MIT | build/test |
| Console | [@esbuild/linux-riscv64](https://www.npmjs.com/package/@esbuild/linux-riscv64) | 0.25.12 | MIT | build/test |
| Console | [@esbuild/linux-s390x](https://www.npmjs.com/package/@esbuild/linux-s390x) | 0.25.12 | MIT | build/test |
| Console | [@esbuild/linux-x64](https://www.npmjs.com/package/@esbuild/linux-x64) | 0.25.12 | MIT | build/test |
| Console | [@esbuild/netbsd-arm64](https://www.npmjs.com/package/@esbuild/netbsd-arm64) | 0.25.12 | MIT | build/test |
| Console | [@esbuild/netbsd-x64](https://www.npmjs.com/package/@esbuild/netbsd-x64) | 0.25.12 | MIT | build/test |
| Console | [@esbuild/openbsd-arm64](https://www.npmjs.com/package/@esbuild/openbsd-arm64) | 0.25.12 | MIT | build/test |
| Console | [@esbuild/openbsd-x64](https://www.npmjs.com/package/@esbuild/openbsd-x64) | 0.25.12 | MIT | build/test |
| Console | [@esbuild/openharmony-arm64](https://www.npmjs.com/package/@esbuild/openharmony-arm64) | 0.25.12 | MIT | build/test |
| Console | [@esbuild/sunos-x64](https://www.npmjs.com/package/@esbuild/sunos-x64) | 0.25.12 | MIT | build/test |
| Console | [@esbuild/win32-arm64](https://www.npmjs.com/package/@esbuild/win32-arm64) | 0.25.12 | MIT | build/test |
| Console | [@esbuild/win32-ia32](https://www.npmjs.com/package/@esbuild/win32-ia32) | 0.25.12 | MIT | build/test |
| Console | [@esbuild/win32-x64](https://www.npmjs.com/package/@esbuild/win32-x64) | 0.25.12 | MIT | build/test |
| Console | [@floating-ui/core](https://www.npmjs.com/package/@floating-ui/core) | 1.7.5 | MIT | runtime |
| Console | [@floating-ui/dom](https://www.npmjs.com/package/@floating-ui/dom) | 1.7.6 | MIT | runtime |
| Console | [@floating-ui/utils](https://www.npmjs.com/package/@floating-ui/utils) | 0.2.11 | MIT | runtime |
| Console | [@jridgewell/sourcemap-codec](https://www.npmjs.com/package/@jridgewell/sourcemap-codec) | 1.5.5 | MIT | runtime |
| Console | [@mixmark-io/domino](https://www.npmjs.com/package/@mixmark-io/domino) | 2.2.0 | BSD-2-Clause | runtime |
| Console | [@popperjs/core](https://www.npmjs.com/package/@popperjs/core) | 2.11.8 | MIT | runtime |
| Console | [@rollup/rollup-android-arm-eabi](https://www.npmjs.com/package/@rollup/rollup-android-arm-eabi) | 4.61.1 | MIT | build/test |
| Console | [@rollup/rollup-android-arm64](https://www.npmjs.com/package/@rollup/rollup-android-arm64) | 4.61.1 | MIT | build/test |
| Console | [@rollup/rollup-darwin-arm64](https://www.npmjs.com/package/@rollup/rollup-darwin-arm64) | 4.61.1 | MIT | build/test |
| Console | [@rollup/rollup-darwin-x64](https://www.npmjs.com/package/@rollup/rollup-darwin-x64) | 4.61.1 | MIT | build/test |
| Console | [@rollup/rollup-freebsd-arm64](https://www.npmjs.com/package/@rollup/rollup-freebsd-arm64) | 4.61.1 | MIT | build/test |
| Console | [@rollup/rollup-freebsd-x64](https://www.npmjs.com/package/@rollup/rollup-freebsd-x64) | 4.61.1 | MIT | build/test |
| Console | [@rollup/rollup-linux-arm-gnueabihf](https://www.npmjs.com/package/@rollup/rollup-linux-arm-gnueabihf) | 4.61.1 | MIT | build/test |
| Console | [@rollup/rollup-linux-arm-musleabihf](https://www.npmjs.com/package/@rollup/rollup-linux-arm-musleabihf) | 4.61.1 | MIT | build/test |
| Console | [@rollup/rollup-linux-arm64-gnu](https://www.npmjs.com/package/@rollup/rollup-linux-arm64-gnu) | 4.61.1 | MIT | build/test |
| Console | [@rollup/rollup-linux-arm64-musl](https://www.npmjs.com/package/@rollup/rollup-linux-arm64-musl) | 4.61.1 | MIT | build/test |
| Console | [@rollup/rollup-linux-loong64-gnu](https://www.npmjs.com/package/@rollup/rollup-linux-loong64-gnu) | 4.61.1 | MIT | build/test |
| Console | [@rollup/rollup-linux-loong64-musl](https://www.npmjs.com/package/@rollup/rollup-linux-loong64-musl) | 4.61.1 | MIT | build/test |
| Console | [@rollup/rollup-linux-ppc64-gnu](https://www.npmjs.com/package/@rollup/rollup-linux-ppc64-gnu) | 4.61.1 | MIT | build/test |
| Console | [@rollup/rollup-linux-ppc64-musl](https://www.npmjs.com/package/@rollup/rollup-linux-ppc64-musl) | 4.61.1 | MIT | build/test |
| Console | [@rollup/rollup-linux-riscv64-gnu](https://www.npmjs.com/package/@rollup/rollup-linux-riscv64-gnu) | 4.61.1 | MIT | build/test |
| Console | [@rollup/rollup-linux-riscv64-musl](https://www.npmjs.com/package/@rollup/rollup-linux-riscv64-musl) | 4.61.1 | MIT | build/test |
| Console | [@rollup/rollup-linux-s390x-gnu](https://www.npmjs.com/package/@rollup/rollup-linux-s390x-gnu) | 4.61.1 | MIT | build/test |
| Console | [@rollup/rollup-linux-x64-gnu](https://www.npmjs.com/package/@rollup/rollup-linux-x64-gnu) | 4.61.1 | MIT | build/test |
| Console | [@rollup/rollup-linux-x64-musl](https://www.npmjs.com/package/@rollup/rollup-linux-x64-musl) | 4.61.1 | MIT | build/test |
| Console | [@rollup/rollup-openbsd-x64](https://www.npmjs.com/package/@rollup/rollup-openbsd-x64) | 4.61.1 | MIT | build/test |
| Console | [@rollup/rollup-openharmony-arm64](https://www.npmjs.com/package/@rollup/rollup-openharmony-arm64) | 4.61.1 | MIT | build/test |
| Console | [@rollup/rollup-win32-arm64-msvc](https://www.npmjs.com/package/@rollup/rollup-win32-arm64-msvc) | 4.61.1 | MIT | build/test |
| Console | [@rollup/rollup-win32-ia32-msvc](https://www.npmjs.com/package/@rollup/rollup-win32-ia32-msvc) | 4.61.1 | MIT | build/test |
| Console | [@rollup/rollup-win32-x64-gnu](https://www.npmjs.com/package/@rollup/rollup-win32-x64-gnu) | 4.61.1 | MIT | build/test |
| Console | [@rollup/rollup-win32-x64-msvc](https://www.npmjs.com/package/@rollup/rollup-win32-x64-msvc) | 4.61.1 | MIT | build/test |
| Console | [@types/estree](https://www.npmjs.com/package/@types/estree) | 1.0.9 | MIT | build/test |
| Console | [@types/lodash](https://www.npmjs.com/package/@types/lodash) | 4.17.24 | MIT | runtime |
| Console | [@types/lodash-es](https://www.npmjs.com/package/@types/lodash-es) | 4.17.12 | MIT | runtime |
| Console | [@types/web-bluetooth](https://www.npmjs.com/package/@types/web-bluetooth) | 0.0.21 | MIT | runtime |
| Console | [@vitejs/plugin-vue](https://www.npmjs.com/package/@vitejs/plugin-vue) | 5.2.4 | MIT | build/test |
| Console | [@vue/compiler-core](https://www.npmjs.com/package/@vue/compiler-core) | 3.5.35 | MIT | runtime |
| Console | [@vue/compiler-dom](https://www.npmjs.com/package/@vue/compiler-dom) | 3.5.35 | MIT | runtime |
| Console | [@vue/compiler-sfc](https://www.npmjs.com/package/@vue/compiler-sfc) | 3.5.35 | MIT | runtime |
| Console | [@vue/compiler-ssr](https://www.npmjs.com/package/@vue/compiler-ssr) | 3.5.35 | MIT | runtime |
| Console | [@vue/devtools-api](https://www.npmjs.com/package/@vue/devtools-api) | 6.6.4 | MIT | runtime |
| Console | [@vue/reactivity](https://www.npmjs.com/package/@vue/reactivity) | 3.5.35 | MIT | runtime |
| Console | [@vue/runtime-core](https://www.npmjs.com/package/@vue/runtime-core) | 3.5.35 | MIT | runtime |
| Console | [@vue/runtime-dom](https://www.npmjs.com/package/@vue/runtime-dom) | 3.5.35 | MIT | runtime |
| Console | [@vue/server-renderer](https://www.npmjs.com/package/@vue/server-renderer) | 3.5.35 | MIT | runtime |
| Console | [@vue/shared](https://www.npmjs.com/package/@vue/shared) | 3.5.35 | MIT | runtime |
| Console | [@vueuse/core](https://www.npmjs.com/package/@vueuse/core) | 14.3.0 | MIT | runtime |
| Console | [@vueuse/metadata](https://www.npmjs.com/package/@vueuse/metadata) | 14.3.0 | MIT | runtime |
| Console | [@vueuse/shared](https://www.npmjs.com/package/@vueuse/shared) | 14.3.0 | MIT | runtime |
| Console | [@xmldom/xmldom](https://www.npmjs.com/package/@xmldom/xmldom) | 0.8.13 | MIT | runtime |
| Console | [argparse](https://www.npmjs.com/package/argparse) | 1.0.10 | MIT | runtime |
| Console | [async-validator](https://www.npmjs.com/package/async-validator) | 4.2.5 | MIT | runtime |
| Console | [base64-js](https://www.npmjs.com/package/base64-js) | 1.5.1 | MIT | runtime |
| Console | [bluebird](https://www.npmjs.com/package/bluebird) | 3.4.7 | MIT | runtime |
| Console | [core-util-is](https://www.npmjs.com/package/core-util-is) | 1.0.3 | MIT | runtime |
| Console | [csstype](https://www.npmjs.com/package/csstype) | 3.2.3 | MIT | runtime |
| Console | [dayjs](https://www.npmjs.com/package/dayjs) | 1.11.21 | MIT | runtime |
| Console | [dingbat-to-unicode](https://www.npmjs.com/package/dingbat-to-unicode) | 1.0.1 | BSD-2-Clause | runtime |
| Console | [duck](https://www.npmjs.com/package/duck) | 0.1.12 | BSD | runtime |
| Console | [element-plus](https://www.npmjs.com/package/element-plus) | 2.14.1 | MIT | runtime |
| Console | [entities](https://www.npmjs.com/package/entities) | 7.0.1 | BSD-2-Clause | runtime |
| Console | [esbuild](https://www.npmjs.com/package/esbuild) | 0.25.12 | MIT | build/test |
| Console | [estree-walker](https://www.npmjs.com/package/estree-walker) | 2.0.2 | MIT | runtime |
| Console | [fdir](https://www.npmjs.com/package/fdir) | 6.5.0 | MIT | build/test |
| Console | [fsevents](https://www.npmjs.com/package/fsevents) | 2.3.3 | MIT | build/test |
| Console | [immediate](https://www.npmjs.com/package/immediate) | 3.0.6 | MIT | runtime |
| Console | [inherits](https://www.npmjs.com/package/inherits) | 2.0.4 | ISC | runtime |
| Console | [isarray](https://www.npmjs.com/package/isarray) | 1.0.0 | MIT | runtime |
| Console | [jszip](https://www.npmjs.com/package/jszip) | 3.10.1 | (MIT OR GPL-3.0-or-later) | runtime |
| Console | [lie](https://www.npmjs.com/package/lie) | 3.3.0 | MIT | runtime |
| Console | [lodash](https://www.npmjs.com/package/lodash) | 4.18.1 | MIT | runtime |
| Console | [lodash-es](https://www.npmjs.com/package/lodash-es) | 4.18.1 | MIT | runtime |
| Console | [lodash-unified](https://www.npmjs.com/package/lodash-unified) | 1.0.3 | MIT | runtime |
| Console | [lop](https://www.npmjs.com/package/lop) | 0.4.2 | BSD-2-Clause | runtime |
| Console | [magic-string](https://www.npmjs.com/package/magic-string) | 0.30.21 | MIT | runtime |
| Console | [mammoth](https://www.npmjs.com/package/mammoth) | 1.12.0 | BSD-2-Clause | runtime |
| Console | [memoize-one](https://www.npmjs.com/package/memoize-one) | 6.0.0 | MIT | runtime |
| Console | [nanoid](https://www.npmjs.com/package/nanoid) | 3.3.12 | MIT | runtime |
| Console | [normalize-wheel-es](https://www.npmjs.com/package/normalize-wheel-es) | 1.2.0 | BSD-3-Clause | runtime |
| Console | [option](https://www.npmjs.com/package/option) | 0.2.4 | BSD-2-Clause | runtime |
| Console | [pako](https://www.npmjs.com/package/pako) | 1.0.11 | (MIT AND Zlib) | runtime |
| Console | [path-is-absolute](https://www.npmjs.com/package/path-is-absolute) | 1.0.1 | MIT | runtime |
| Console | [picocolors](https://www.npmjs.com/package/picocolors) | 1.1.1 | ISC | runtime |
| Console | [picomatch](https://www.npmjs.com/package/picomatch) | 4.0.4 | MIT | build/test |
| Console | [pinia](https://www.npmjs.com/package/pinia) | 2.3.1 | MIT | runtime |
| Console | [postcss](https://www.npmjs.com/package/postcss) | 8.5.15 | MIT | runtime |
| Console | [process-nextick-args](https://www.npmjs.com/package/process-nextick-args) | 2.0.1 | MIT | runtime |
| Console | [readable-stream](https://www.npmjs.com/package/readable-stream) | 2.3.8 | MIT | runtime |
| Console | [rollup](https://www.npmjs.com/package/rollup) | 4.61.1 | MIT | build/test |
| Console | [safe-buffer](https://www.npmjs.com/package/safe-buffer) | 5.1.2 | MIT | runtime |
| Console | [setimmediate](https://www.npmjs.com/package/setimmediate) | 1.0.5 | MIT | runtime |
| Console | [source-map-js](https://www.npmjs.com/package/source-map-js) | 1.2.1 | BSD-3-Clause | runtime |
| Console | [sprintf-js](https://www.npmjs.com/package/sprintf-js) | 1.0.3 | BSD-3-Clause | runtime |
| Console | [string_decoder](https://www.npmjs.com/package/string_decoder) | 1.1.1 | MIT | runtime |
| Console | [tinyglobby](https://www.npmjs.com/package/tinyglobby) | 0.2.17 | MIT | build/test |
| Console | [turndown](https://www.npmjs.com/package/turndown) | 7.2.4 | MIT | runtime |
| Console | [typescript](https://www.npmjs.com/package/typescript) | 5.9.3 | Apache-2.0 | runtime |
| Console | [underscore](https://www.npmjs.com/package/underscore) | 1.13.8 | MIT | runtime |
| Console | [util-deprecate](https://www.npmjs.com/package/util-deprecate) | 1.0.2 | MIT | runtime |
| Console | [vite](https://www.npmjs.com/package/vite) | 6.4.3 | MIT | build/test |
| Console | [vue](https://www.npmjs.com/package/vue) | 3.5.35 | MIT | runtime |
| Console | [vue-component-type-helpers](https://www.npmjs.com/package/vue-component-type-helpers) | 3.3.4 | MIT | runtime |
| Console | [vue-demi](https://www.npmjs.com/package/vue-demi) | 0.14.10 | MIT | runtime |
| Console | [vue-router](https://www.npmjs.com/package/vue-router) | 4.6.4 | MIT | runtime |
| Console | [xmlbuilder](https://www.npmjs.com/package/xmlbuilder) | 10.1.1 | MIT | runtime |
| Hub | [@esbuild/aix-ppc64](https://www.npmjs.com/package/@esbuild/aix-ppc64) | 0.28.1 | MIT | build/test |
| Hub | [@esbuild/android-arm](https://www.npmjs.com/package/@esbuild/android-arm) | 0.28.1 | MIT | build/test |
| Hub | [@esbuild/android-arm64](https://www.npmjs.com/package/@esbuild/android-arm64) | 0.28.1 | MIT | build/test |
| Hub | [@esbuild/android-x64](https://www.npmjs.com/package/@esbuild/android-x64) | 0.28.1 | MIT | build/test |
| Hub | [@esbuild/darwin-arm64](https://www.npmjs.com/package/@esbuild/darwin-arm64) | 0.28.1 | MIT | build/test |
| Hub | [@esbuild/darwin-x64](https://www.npmjs.com/package/@esbuild/darwin-x64) | 0.28.1 | MIT | build/test |
| Hub | [@esbuild/freebsd-arm64](https://www.npmjs.com/package/@esbuild/freebsd-arm64) | 0.28.1 | MIT | build/test |
| Hub | [@esbuild/freebsd-x64](https://www.npmjs.com/package/@esbuild/freebsd-x64) | 0.28.1 | MIT | build/test |
| Hub | [@esbuild/linux-arm](https://www.npmjs.com/package/@esbuild/linux-arm) | 0.28.1 | MIT | build/test |
| Hub | [@esbuild/linux-arm64](https://www.npmjs.com/package/@esbuild/linux-arm64) | 0.28.1 | MIT | build/test |
| Hub | [@esbuild/linux-ia32](https://www.npmjs.com/package/@esbuild/linux-ia32) | 0.28.1 | MIT | build/test |
| Hub | [@esbuild/linux-loong64](https://www.npmjs.com/package/@esbuild/linux-loong64) | 0.28.1 | MIT | build/test |
| Hub | [@esbuild/linux-mips64el](https://www.npmjs.com/package/@esbuild/linux-mips64el) | 0.28.1 | MIT | build/test |
| Hub | [@esbuild/linux-ppc64](https://www.npmjs.com/package/@esbuild/linux-ppc64) | 0.28.1 | MIT | build/test |
| Hub | [@esbuild/linux-riscv64](https://www.npmjs.com/package/@esbuild/linux-riscv64) | 0.28.1 | MIT | build/test |
| Hub | [@esbuild/linux-s390x](https://www.npmjs.com/package/@esbuild/linux-s390x) | 0.28.1 | MIT | build/test |
| Hub | [@esbuild/linux-x64](https://www.npmjs.com/package/@esbuild/linux-x64) | 0.28.1 | MIT | build/test |
| Hub | [@esbuild/netbsd-arm64](https://www.npmjs.com/package/@esbuild/netbsd-arm64) | 0.28.1 | MIT | build/test |
| Hub | [@esbuild/netbsd-x64](https://www.npmjs.com/package/@esbuild/netbsd-x64) | 0.28.1 | MIT | build/test |
| Hub | [@esbuild/openbsd-arm64](https://www.npmjs.com/package/@esbuild/openbsd-arm64) | 0.28.1 | MIT | build/test |
| Hub | [@esbuild/openbsd-x64](https://www.npmjs.com/package/@esbuild/openbsd-x64) | 0.28.1 | MIT | build/test |
| Hub | [@esbuild/openharmony-arm64](https://www.npmjs.com/package/@esbuild/openharmony-arm64) | 0.28.1 | MIT | build/test |
| Hub | [@esbuild/sunos-x64](https://www.npmjs.com/package/@esbuild/sunos-x64) | 0.28.1 | MIT | build/test |
| Hub | [@esbuild/win32-arm64](https://www.npmjs.com/package/@esbuild/win32-arm64) | 0.28.1 | MIT | build/test |
| Hub | [@esbuild/win32-ia32](https://www.npmjs.com/package/@esbuild/win32-ia32) | 0.28.1 | MIT | build/test |
| Hub | [@esbuild/win32-x64](https://www.npmjs.com/package/@esbuild/win32-x64) | 0.28.1 | MIT | build/test |
| Hub | [@napi-rs/canvas](https://www.npmjs.com/package/@napi-rs/canvas) | 0.1.100 | MIT | runtime |
| Hub | [@napi-rs/canvas-android-arm64](https://www.npmjs.com/package/@napi-rs/canvas-android-arm64) | 0.1.100 | MIT | runtime |
| Hub | [@napi-rs/canvas-darwin-arm64](https://www.npmjs.com/package/@napi-rs/canvas-darwin-arm64) | 0.1.100 | MIT | runtime |
| Hub | [@napi-rs/canvas-darwin-x64](https://www.npmjs.com/package/@napi-rs/canvas-darwin-x64) | 0.1.100 | MIT | runtime |
| Hub | [@napi-rs/canvas-linux-arm-gnueabihf](https://www.npmjs.com/package/@napi-rs/canvas-linux-arm-gnueabihf) | 0.1.100 | MIT | runtime |
| Hub | [@napi-rs/canvas-linux-arm64-gnu](https://www.npmjs.com/package/@napi-rs/canvas-linux-arm64-gnu) | 0.1.100 | MIT | runtime |
| Hub | [@napi-rs/canvas-linux-arm64-musl](https://www.npmjs.com/package/@napi-rs/canvas-linux-arm64-musl) | 0.1.100 | MIT | runtime |
| Hub | [@napi-rs/canvas-linux-riscv64-gnu](https://www.npmjs.com/package/@napi-rs/canvas-linux-riscv64-gnu) | 0.1.100 | MIT | runtime |
| Hub | [@napi-rs/canvas-linux-x64-gnu](https://www.npmjs.com/package/@napi-rs/canvas-linux-x64-gnu) | 0.1.100 | MIT | runtime |
| Hub | [@napi-rs/canvas-linux-x64-musl](https://www.npmjs.com/package/@napi-rs/canvas-linux-x64-musl) | 0.1.100 | MIT | runtime |
| Hub | [@napi-rs/canvas-win32-arm64-msvc](https://www.npmjs.com/package/@napi-rs/canvas-win32-arm64-msvc) | 0.1.100 | MIT | runtime |
| Hub | [@napi-rs/canvas-win32-x64-msvc](https://www.npmjs.com/package/@napi-rs/canvas-win32-x64-msvc) | 0.1.100 | MIT | runtime |
| Hub | [@types/node](https://www.npmjs.com/package/@types/node) | 22.19.20 | MIT | runtime |
| Hub | [@xmldom/xmldom](https://www.npmjs.com/package/@xmldom/xmldom) | 0.8.13 | MIT | runtime |
| Hub | [argparse](https://www.npmjs.com/package/argparse) | 1.0.10 | MIT | runtime |
| Hub | [aws-ssl-profiles](https://www.npmjs.com/package/aws-ssl-profiles) | 1.1.2 | MIT | runtime |
| Hub | [base64-js](https://www.npmjs.com/package/base64-js) | 1.5.1 | MIT | runtime |
| Hub | [bluebird](https://www.npmjs.com/package/bluebird) | 3.4.7 | MIT | runtime |
| Hub | [core-util-is](https://www.npmjs.com/package/core-util-is) | 1.0.3 | MIT | runtime |
| Hub | [denque](https://www.npmjs.com/package/denque) | 2.1.0 | Apache-2.0 | runtime |
| Hub | [dingbat-to-unicode](https://www.npmjs.com/package/dingbat-to-unicode) | 1.0.1 | BSD-2-Clause | runtime |
| Hub | [duck](https://www.npmjs.com/package/duck) | 0.1.12 | BSD | runtime |
| Hub | [esbuild](https://www.npmjs.com/package/esbuild) | 0.28.1 | MIT | build/test |
| Hub | [fsevents](https://www.npmjs.com/package/fsevents) | 2.3.2 | MIT | build/test |
| Hub | [fsevents](https://www.npmjs.com/package/fsevents) | 2.3.3 | MIT | build/test |
| Hub | [generate-function](https://www.npmjs.com/package/generate-function) | 2.3.1 | MIT | runtime |
| Hub | [iconv-lite](https://www.npmjs.com/package/iconv-lite) | 0.7.2 | MIT | runtime |
| Hub | [immediate](https://www.npmjs.com/package/immediate) | 3.0.6 | MIT | runtime |
| Hub | [inherits](https://www.npmjs.com/package/inherits) | 2.0.4 | ISC | runtime |
| Hub | [is-property](https://www.npmjs.com/package/is-property) | 1.0.2 | MIT | runtime |
| Hub | [isarray](https://www.npmjs.com/package/isarray) | 1.0.0 | MIT | runtime |
| Hub | [jszip](https://www.npmjs.com/package/jszip) | 3.10.1 | (MIT OR GPL-3.0-or-later) | runtime |
| Hub | [lie](https://www.npmjs.com/package/lie) | 3.3.0 | MIT | runtime |
| Hub | [long](https://www.npmjs.com/package/long) | 5.3.2 | Apache-2.0 | runtime |
| Hub | [lop](https://www.npmjs.com/package/lop) | 0.4.2 | BSD-2-Clause | runtime |
| Hub | [lru.min](https://www.npmjs.com/package/lru.min) | 1.1.4 | MIT | runtime |
| Hub | [mammoth](https://www.npmjs.com/package/mammoth) | 1.12.0 | BSD-2-Clause | runtime |
| Hub | [mysql2](https://www.npmjs.com/package/mysql2) | 3.22.5 | MIT | runtime |
| Hub | [named-placeholders](https://www.npmjs.com/package/named-placeholders) | 1.1.6 | MIT | runtime |
| Hub | [option](https://www.npmjs.com/package/option) | 0.2.4 | BSD-2-Clause | runtime |
| Hub | [pako](https://www.npmjs.com/package/pako) | 1.0.11 | (MIT AND Zlib) | runtime |
| Hub | [path-is-absolute](https://www.npmjs.com/package/path-is-absolute) | 1.0.1 | MIT | runtime |
| Hub | [pdfjs-dist](https://www.npmjs.com/package/pdfjs-dist) | 5.7.284 | Apache-2.0 | runtime |
| Hub | [playwright](https://www.npmjs.com/package/playwright) | 1.61.1 | Apache-2.0 | build/test |
| Hub | [playwright-core](https://www.npmjs.com/package/playwright-core) | 1.61.1 | Apache-2.0 | build/test |
| Hub | [process-nextick-args](https://www.npmjs.com/package/process-nextick-args) | 2.0.1 | MIT | runtime |
| Hub | [readable-stream](https://www.npmjs.com/package/readable-stream) | 2.3.8 | MIT | runtime |
| Hub | [safe-buffer](https://www.npmjs.com/package/safe-buffer) | 5.1.2 | MIT | runtime |
| Hub | [safer-buffer](https://www.npmjs.com/package/safer-buffer) | 2.1.2 | MIT | runtime |
| Hub | [setimmediate](https://www.npmjs.com/package/setimmediate) | 1.0.5 | MIT | runtime |
| Hub | [sprintf-js](https://www.npmjs.com/package/sprintf-js) | 1.0.3 | BSD-3-Clause | runtime |
| Hub | [sql-escaper](https://www.npmjs.com/package/sql-escaper) | 1.3.3 | MIT | runtime |
| Hub | [string_decoder](https://www.npmjs.com/package/string_decoder) | 1.1.1 | MIT | runtime |
| Hub | [tsx](https://www.npmjs.com/package/tsx) | 4.22.4 | MIT | build/test |
| Hub | [typescript](https://www.npmjs.com/package/typescript) | 5.9.3 | Apache-2.0 | build/test |
| Hub | [underscore](https://www.npmjs.com/package/underscore) | 1.13.8 | MIT | runtime |
| Hub | [undici-types](https://www.npmjs.com/package/undici-types) | 6.21.0 | MIT | runtime |
| Hub | [util-deprecate](https://www.npmjs.com/package/util-deprecate) | 1.0.2 | MIT | runtime |
| Hub | [xmlbuilder](https://www.npmjs.com/package/xmlbuilder) | 10.1.1 | MIT | runtime |
| Hub | [yaml](https://www.npmjs.com/package/yaml) | 2.9.0 | ISC | runtime |

## No Endorsement

The names and marks of third-party projects belong to their respective owners. Their inclusion does not imply endorsement of BailingHub, and BailingHub does not claim ownership of those projects.
