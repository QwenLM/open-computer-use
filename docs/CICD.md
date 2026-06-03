# CI/CD 说明

这个模板自带一套不依赖具体语言栈的 CI/CD 骨架。

## 当前 release 入口

- `scripts/release-package.sh`：构建 universal `Open Computer Use.app`，cross-compile Linux / Windows runtime，stage scoped npm 包 `@qwen-code/open-computer-use`；包内会内置 macOS app、Linux binaries 和 Windows exes，并产出 `dist/release/npm/*.tgz` 与 `dist/release/release-manifest.json`。配置了 `OPEN_COMPUTER_USE_CODESIGN_*` secrets 时用 `Developer ID Application` 证书签 `.app`；未配置时回退 ad-hoc signing。本地 debug/dev 构建允许使用开发机自己的签名身份。
- `scripts/build-open-computer-use-linux.sh`：本地构建实验性 Linux `open-computer-use` binary，支持 `arm64` / `amd64`；release package 会把这两个产物内置进 npm 包的 `dist/linux/`。
- `scripts/build-open-computer-use-windows.sh`：本地构建实验性 Windows `open-computer-use.exe`，支持 `arm64` / `amd64`；release package 会把这两个产物内置进 npm 包的 `dist/windows/`。
- `.github/workflows/release.yml`：支持 push semver tag 自动发布，也支持 `workflow_dispatch` 手动触发（手动触发默认不 publish，仅验证 build/sign）。tag push 时跑 npm release 打包并 publish `@qwen-code/open-computer-use` 到 npmjs.org。`Open Computer Use` 的 `.app` 在配置了 `OPEN_COMPUTER_USE_CODESIGN_*` secrets 时用 `Developer ID Application` 证书签名；若同时配置 `APPLE_NOTARY_*` secrets（App Store Connect API Key），tag push 构建会在签名后对 `.app` 做 notarization 并 staple，使分发到 npm 的 bundle 通过 Gatekeeper 离线校验。缺少 notary 凭据时构建照常成功（签名但未公证）。

## 设计原则

这套默认流水线的目标，是在项目真正成形前先把交付链路搭起来，而不是假装已经知道未来项目该怎么 build 和 deploy。

当新项目的技术栈确定后，你应该继续在 `scripts/release-package.sh` 这条真实构建链路上扩展，而不是另起一套平行流程。

所有 GitHub Actions 都已经 pin 到 commit SHA。后续升级 action 时，也要继续保持这个约束。

## 推荐接入顺序

1. 保留 `ci.yml`，作为仓库的基础门禁。
2. 在 `scripts/ci.sh` 里继续叠加项目自己的验证命令。
3. 在 `scripts/release-package.sh` 已有的真实构建基础上继续扩展 release 产物。
4. 技术栈和环境稳定后，再补具体的部署 job。
5. 即使交付方式变化，SBOM 和 provenance 这类供应链能力也建议保留。

## 默认 release 产物

当前 release 流水线会产出：

- `dist/release/release-manifest.json`
- `dist/release/npm/@qwen-code/open-computer-use-<version>.tgz`
- GitHub Actions 中上传的 npm release artifact
- tag push 时 publish 到 npmjs.org 的 `@qwen-code/open-computer-use@<version>`

也就是说，仓库具备一条由 git tag 驱动、真实可复用的 npm 制品封装 + 签名（可选公证）+ 发布链路。
