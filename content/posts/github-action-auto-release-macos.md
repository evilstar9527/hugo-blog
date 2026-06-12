---
title: "给一个 macOS 小工具配上 push 即发版的 GitHub Action"
date: 2026-06-06
draft: false
tags: ["github-actions", "macos", "ci/cd", "swift"]
categories: ["notes"]
---

最近写了个菜单栏小工具，管理 git worktree 用的。功能慢慢成形之后，就遇到一个很现实的问题：怎么发版。

手动发版是能跑的——本地 `xcodebuild` 打个包，签个名，做成 dmg，再上传到 GitHub Release。问题是这套动作我每次都要重来一遍，而且总有哪一步会忘。打包忘了改版本号、签名漏了某个嵌套 framework、dmg 名字和上次对不上……这种事一旦靠记性，迟早出错。

我想要的其实很简单：改个版本号，推一下，剩下的别让我管。

这套「push 到 release 分支就自动出包」的流程，我其实之前在自己 fork 的 Ghostty（我自己魔改的 Ghostty++）里就搭过一套。那套要复杂得多——后面会专门说一下复杂在哪。这次我等于是把那套的骨架抠出来，砍掉它特有的、我这个小工具用不上的部分，重新拼一个最小可用版本。这篇就记一下这个过程，顺便把中间踩的一个坑写清楚。

## GitHub 仓库

这个小工具叫 [Worktree Bar](https://github.com/evilstar9527/worktree-bar)，是一个 macOS 菜单栏 app，用来管理多个项目里的 git worktree。仓库里能看到完整的最终形态：SwiftUI 源码、`project.yml`、`VERSION`，以及真正跑发布的 `.github/workflows/release-branch.yml`。

这篇文章不是单独讲 app 功能，所以源码细节先不展开。对发布流程来说，真正重要的是三个文件：

- `VERSION`：发版版本号的唯一来源；
- `project.yml`：XcodeGen 的工程描述，CI 会把版本号写进这里；
- `.github/workflows/release-branch.yml`：push 到 `release` 分支后自动构建、签名、打包、发 Release 的 workflow。

如果想直接对照代码看，最好从 workflow 文件开始。它基本就是这篇文章后面每一段的可执行版本。

## GitHub Release 页面

最终产物也直接挂在 GitHub Release 上：[Worktree Bar Releases](https://github.com/evilstar9527/worktree-bar/releases)。

现在这套流程跑完之后，GitHub 上会出现一个形如 `v0.1.0` 的 tag 和一个同名 Release，Release 里挂着 `WorktreeBar-v0.1.0.dmg`。下载这个 dmg，拖进 Applications，就完成安装。因为它是 ad-hoc signed 的个人工具，不走 Apple Developer ID，所以第一次打开时 Gatekeeper 还会拦一下，这个限制不是 GitHub Action 能解决的。

这里我没有做 Sparkle 那种 app 内自动更新，也没有做 notarization。原因很简单：这个工具目前就是个人使用的小工具，核心目标是「我 push 一下就能拿到可下载的 dmg」，而不是做一个完整商业软件的分发链路。把问题边界收窄之后，workflow 才能保持在一个很好维护的复杂度里。

## 整体思路

发布这件事，我希望它有一个明确的「触发点」。不是每次 push 都发版——那太吵了——而是专门留一个 `release` 分支，只有内容进到这个分支才发版。平时在 `main` 上随便改，想发了再把改动推进 `release`。

版本号我放在一个单独的 `VERSION` 文件里，就一行：

```
0.1.0
```

这样版本号有了唯一的来源。CI 读这个文件，校验格式，再把它盖进构建里。要发新版，改这一行就行，不用去翻 Xcode 工程设置。

整条流水线干的事情是这样的：

```
push 到 release 分支
    ↓
读 VERSION，算出 tag（v0.1.0）
    ↓
检查这个 tag 是不是已经发过了
    ↓
生成 Xcode 工程 → 编译 Release
    ↓
ad-hoc 签名 → 打成 dmg
    ↓
建 GitHub Release，把 dmg 挂上去
```

## workflow 本体

触发部分很直接，盯着 `release` 分支，外加一个手动触发的口子方便调试：

```yaml
on:
  push:
    branches:
      - release
  workflow_dispatch:

permissions:
  contents: write

concurrency:
  group: release-branch
  cancel-in-progress: false
```

`permissions: contents: write` 是必须的，不然最后建 Release 那一步没权限。`concurrency` 是为了防止同时跑两次发版把产物搞乱——发布这种事，一次只能有一个在跑。

读版本号这一步顺便把几个后面要用的值都算出来：

```yaml
- name: Read version
  id: version
  run: |
    VERSION="$(tr -d '[:space:]' < VERSION)"
    if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "VERSION must be X.Y.Z, got: $VERSION"
      exit 1
    fi
    BUILD="$(git rev-list --count HEAD)"
    TAG="v${VERSION}"
    DMG_NAME="WorktreeBar-v${VERSION}.dmg"
    echo "version=$VERSION" >> "$GITHUB_OUTPUT"
    echo "build=$BUILD" >> "$GITHUB_OUTPUT"
    echo "tag=$TAG" >> "$GITHUB_OUTPUT"
    echo "dmg_name=$DMG_NAME" >> "$GITHUB_OUTPUT"
```

`BUILD` 用 commit 总数来当 build number，简单可靠，每次都递增。正则那一行是个小保险：万一 `VERSION` 写错了格式，让它在这里就停下来，而不是跑到一半才发现。

然后是一个我觉得很值的步骤——发版前先检查这个 tag 是不是已经存在：

```yaml
- name: Check release does not exist
  env:
    GH_TOKEN: ${{ github.token }}
    TAG: ${{ steps.version.outputs.tag }}
  run: |
    if git ls-remote --exit-code --tags origin "refs/tags/${TAG}" >/dev/null 2>&1; then
      echo "Tag already exists: ${TAG}"
      exit 1
    fi
    if gh release view "$TAG" >/dev/null 2>&1; then
      echo "GitHub Release already exists: ${TAG}"
      exit 1
    fi
```

有了这一步，我重复 push `release` 分支也不怕——只要没改 `VERSION`，它会在这里直接失败，不会覆盖已有的 Release。这种「想犯错都犯不了」的设计，比事后小心要可靠得多。

## 版本号怎么盖进去

我这个项目用 XcodeGen，工程文件是 `project.yml` 生成出来的。所以版本号要进到 app 里，得先改 `project.yml`，再 generate：

```yaml
- name: Install XcodeGen
  run: brew install xcodegen

- name: Patch version into project.yml
  env:
    APP_VERSION: ${{ steps.version.outputs.version }}
    APP_BUILD: ${{ steps.version.outputs.build }}
  run: |
    sed -i '' -E "s/MARKETING_VERSION: \"[^\"]*\"/MARKETING_VERSION: \"${APP_VERSION}\"/" project.yml
    sed -i '' -E "s/CURRENT_PROJECT_VERSION: \"[^\"]*\"/CURRENT_PROJECT_VERSION: \"${APP_BUILD}\"/" project.yml

- name: Generate Xcode project
  run: xcodegen generate
```

这里我特意先在本地拿副本试了一下 `sed`，确认它只改那两行、不会误伤别的内容，才敢放进 CI。`sed -i ''` 是 macOS 的写法（BSD sed 的 `-i` 后面要跟一个空字符串参数），这点和 Linux 不一样，写的时候别想当然。

## 签名和打包

我这个工具是个人用的，没有 Apple 开发者证书，所以走 ad-hoc 签名就行：

```yaml
- name: Ad-hoc codesign app bundle
  run: |
    /usr/bin/codesign --force --deep --sign - "$APP_PATH"
    /usr/bin/codesign --verify --deep --strict --verbose=2 "$APP_PATH"
```

`--sign -` 就是 ad-hoc 签名的意思。我一开始照搬 Ghostty 那边的写法带了 `--options runtime`（hardened runtime），但我这个 app 本来就没开 hardened runtime，加上反而可能验证失败，就去掉了。签完跑一次 `--verify` 确认签名是好的，免得带着坏签名往下走。

打 dmg 用 `create-dmg`：

```yaml
- name: Create DMG
  env:
    DMG_NAME: ${{ steps.version.outputs.dmg_name }}
  run: |
    npm install --global create-dmg
    create-dmg --no-code-sign "$APP_PATH" ./ || true
    mv ./Worktree*.dmg "./${DMG_NAME}"
    test -f "./${DMG_NAME}"
```

这里有两个小细节是我本地试出来的，不试根本想不到：

一个是 `create-dmg` 在跳过签名的时候会返回非零退出码，哪怕 dmg 其实生成成功了。所以我加了 `|| true`，不让它的退出码把整步搞挂，改成后面用 `test -f` 来确认文件在不在。

另一个更隐蔽：`create-dmg` 给文件起的名字是按 app 的显示名来的。我的 app 显示名是「Worktree Bar」（带空格），所以它生成的是 `Worktree Bar 1.0.dmg`，而不是我以为的 `WorktreeBar-xxx.dmg`。我原来的 `mv WorktreeBar*.dmg` 通配符根本匹配不到，得改成 `Worktree*.dmg`。这种东西不在本地真跑一遍，光看脚本是发现不了的。

最后建 Release，用现成的 action：

```yaml
- name: Create GitHub Release
  uses: softprops/action-gh-release@v2
  with:
    tag_name: ${{ steps.version.outputs.tag }}
    target_commitish: ${{ github.sha }}
    name: WorktreeBar ${{ steps.version.outputs.tag }}
    files: |
      ${{ steps.version.outputs.dmg_name }}
    make_latest: true
```

## 那个坑：未来的工程格式

写完之后我满怀信心地把 `release` 分支推上去，结果第一次就挂了。失败在「Build」这一步，跑了十几秒就报错：

```
xcodebuild: error: Unable to read project 'WorktreeBar.xcodeproj'.
  Reason: The project 'WorktreeBar' cannot be opened because it is
  in a future Xcode project file format (77).
```

「future Xcode project file format (77)」——工程文件的格式版本太新了，CI 上的 Xcode 读不了。

原因是我本地用的是 Xcode 16，XcodeGen 生成出来的工程是 objectVersion 77 这个新格式。而我 workflow 里写的是 `runs-on: macos-14`，macos-14 这个 runner 镜像带的是 Xcode 15，它不认这个格式。

本地一切正常，正是因为本地是新 Xcode；一搬到 CI 就露馅。这种「本地能跑、CI 跑不了」的问题，根子上往往就是环境版本对不上。

修起来很简单，把 runner 换成带 Xcode 16 的：

```yaml
runs-on: macos-15
```

`macos-15` 镜像默认是 Xcode 16.4，能读这个格式。改完重新推，这次就一路绿灯跑完了，Release 也老老实实建好了，dmg 挂在上面。

## 对比一下我在 Ghostty++ 里那套

前面说了，这套流程的原型是我给自己魔改的 Ghostty（Ghostty++）加的发布流水线。同样是「push 到 release 分支自动发版」，但那套要重很多。简单说一下它多出来的部分，也算解释一下我这次砍掉了什么。

**第一重复杂是构建本身。** Ghostty 的核心是 Zig 写的，Xcode 那层只是个壳。所以它不能直接 `xcodebuild` 完事，得先用 Nix 把构建环境拉起来，`zig build` 编出 GhosttyKit（核心库），再交给 Xcode 把 app 包出来。光是「准备环境 + 编核心」就是好几步，跑起来也慢。我这个纯 SwiftUI 的小工具没这一层，一句 `xcodebuild` 就出 app 了。

**第二重、也是最麻烦的，是 app 内自动更新。** Ghostty++ 接了 [Sparkle](https://sparkle-project.org/)——就是很多 mac app 那种「发现新版本，点一下就更新」的机制。要支持它，发布流程里凭空多出一整条链路：

- 构建时把 Sparkle 框架塞进 app，往 `Info.plist` 里写更新公钥；
- 打完 dmg 之后，用一个私钥（存在仓库 secrets 里）给 dmg 签一个 EdDSA 签名；
- 再生成一个 `appcast.xml`——这是 Sparkle 的更新 feed，里面记着最新版本号、下载地址、签名。老用户的 app 就是去拉这个 xml 来判断要不要更新的。

这一串东西环环相扣，签名密钥还不能泄露，配置起来比单纯发个 dmg 麻烦得多。而我这个工具是给自己用的，根本没接自动更新，所以这整段我直接没要——发完 dmg、建完 Release 就结束，用户想更新就再下一次。

**还有些零碎的差别**，比如那套用的是带新版 Xcode 的特定 runner 镜像、依赖好几个 secret。但核心就是上面两点：**它要编一个 Zig 核心，还要做 app 内自动更新**。把这两块拿掉，剩下的骨架——盯 release 分支、读版本、防重复、签名、打包、建 Release——其实就是这篇这套了。

所以这次与其说是「从零搭」，不如说是「做减法」。有了那套复杂版打底，反而更清楚哪些是发布流程真正的骨干，哪些只是为某个具体需求（Zig、自动更新）服务的枝节。

## 现在发版是什么样

配好之后，我发新版就三步：

1. 改 `VERSION` 文件里那一行；
2. 提交到 `main`；
3. `git push origin main:release`。

剩下的我不用管。CI 会自己编译、签名、打包、建 Release。要是我手贱重复推了同一个版本，它会在检查那一步直接拒绝，不会把已有的覆盖掉。

回头看，这套东西真正帮我省下来的，不是「自动化」本身那点时间，而是把一堆「容易忘、忘了就出错」的步骤从我脑子里挪了出去。发版这种偶尔才做一次的事，最怕的就是靠记性，而记性恰恰最不可靠。
