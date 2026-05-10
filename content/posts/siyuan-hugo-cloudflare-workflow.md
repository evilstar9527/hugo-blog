---
title: "用思源 + Hugo + Cloudflare 搭建个人博客"
date: 2026-05-10
draft: false
tags: ["hugo", "思源笔记", "cloudflare", "博客搭建"]
categories: ["notes"]
---

这段时间一直想把自己的博客流程收拾得简单一点。

我不太想折腾数据库，也不想维护后台，更不想为了发一篇文章专门登录一个复杂的 CMS。对个人博客来说，写作这件事本来就应该尽量轻，不然写着写着就懒得更新了。

最后我定下来的方案很朴素：用思源写内容，用 Hugo 生成静态页面，用 Cloudflare Pages 部署，再把自己的域名绑上去。这样一来，平时我只需要在思源里写完，点一下发布，剩下的事情交给 GitHub 和 Cloudflare 自动完成。

现在 `evilstar.org` 就是这么跑起来的。

## 我最后用下来的这套结构

```
思源笔记（写作）
    ↓ siyuan-plugin-publisher
GitHub 仓库（hugo-blog）
    ↓ 自动触发
Cloudflare Pages（构建 + 托管）
    ↓
evilstar.org（上线）
```

这套结构我喜欢的地方在于分工很清楚。

思源就是写作工具，Hugo 负责把 Markdown 变成网站，GitHub 存源码，Cloudflare 负责发布。每一层都只做一件事，所以后面几乎不用怎么维护。

## 先把域名和站点跑起来

我先做的是在 Cloudflare 上买域名，然后直接用 Pages 托管 Hugo。

域名放在 Cloudflare 有个很直接的好处：后面绑定 Pages 会非常顺，不用再自己折腾一遍 DNS。买完之后，域名、证书、解析基本都在一个地方处理，省心很多。

进 `dash.cloudflare.com`，在左侧「域名注册」里搜索并购买就行。

## Hugo 项目怎么建

本地先初始化一个 Hugo 项目：

```bash
hugo new site hugo-blog
cd hugo-blog
git init
git remote add origin git@github.com:yourname/hugo-blog.git
```

选主题这件事我也折腾过一阵，最后用了 [hugo-texify3](https://github.com/michaelneuper/hugo-texify3)。它不是那种特别花的主题，但排版很干净，拿来写文字内容挺舒服。

```bash
git submodule add https://github.com/michaelneuper/hugo-texify3 themes/hugo-texify3
```

`hugo.toml` 里我保留的核心配置大概是这样：

```toml
baseURL = "https://evilstar.org/"
title = "EVILSTAR"
theme = "hugo-texify3"
hasCJKLanguage = true

[taxonomies]
tags = "tags"
categories = "categories"
```

推送到 GitHub：

```bash
git add -A && git commit -m "init" && git push -u origin main
```

推到 GitHub 之后，下一步就是把仓库接到 Cloudflare Pages。

Cloudflare Dashboard 里进 Pages，创建项目，连接 GitHub，然后选 `hugo-blog` 这个仓库。

构建配置我这里很简单：

| 字段 | 值 |
|------|-----|
| 构建命令 | `hugo` |
| 输出目录 | `public` |
| Node 版本（环境变量） | `20` |

保存之后，Cloudflare 会立刻跑第一次构建。等它构建完成，再去绑定自定义域名。因为域名本身就在 Cloudflare，整个过程基本没什么阻力，SSL 和解析也会一起处理掉。

这一步配好以后，后面就很省事了。只要 GitHub 仓库有新的提交，Cloudflare Pages 就会自动重新构建，通常过几分钟就能在网站上看到更新。

## 最关键的一步：把思源接进来

前面的 Hugo 和 Pages 其实都不难，真正影响日常体验的反而是写作环节。

我不想每次写完文章之后，还要自己手动复制 Markdown、整理图片、改路径、再 commit 一次。所以最后把思源的 `siyuan-plugin-publisher` 插件也接进来了。

插件装好之后，在「平台导入」里选 GitHub，主要字段这样填：

| 字段 | 值 |
|------|-----|
| git 仓库名 | `hugo-blog` |
| 默认分支 | `main` |
| 存储目录 | `content/posts` |
| 文件规则 | `[slug].md` |
| 文章预览规则 | `/posts/[slug]/` |
| 发布格式 | Markdown |
| 图床服务 | 当前平台 |
| 图片存储目录 | `static/uploads` |
| 图片访问链接 | `/uploads` |

这个 YAML 预设我觉得挺有用，因为它能把一些我每篇文章都会用到的字段提前补上：

```json
{
  "draft": false,
  "categories": ["notes"]
}
```

验证通过之后保存，这套发布链路就算接通了。

## 现在我平时是怎么发文章的

后面真正写起来，流程其实很短：

1. 在思源里新建一篇文档，正常写
2. 写完点右上角发布图标，选 `hugo-blog` 平台
3. 填一个 slug，最好是英文加连字符，比如 `my-new-post`
4. 点发布

剩下的事情插件会自己做：它会把文档转成 Markdown，放进 GitHub 仓库的 `content/posts/`，如果文里有图片，也会一起同步到 `static/uploads/`。Cloudflare Pages 检测到仓库更新后，就会自动开始构建。

这个过程跑通之后，体验会很接近「在本地写完，点一下就上线」。对个人博客来说，我觉得这已经足够舒服了。

## 这套方案也不是完全没有边界

用下来有一个地方需要接受：思源和 Hugo 仓库不是双向同步关系。

思源更像是写作入口，已经发布出去的文章，真正的源文件还是在 GitHub 仓库里。也就是说，思源适合拿来写新文章、重发文章，但如果你想统一查看所有已发布内容、删除文章，还是得回到仓库本身。

我现在的做法也很直接：

- 要看所有文章，就看 `content/posts/`
- 要删文章，就在 GitHub 网页上删，或者在本地仓库删掉后推送
- 要改文章，小改可以直接在 GitHub 改，大改就回思源里改完重新发布

一开始我也想过，能不能把博客里现有的 Markdown 全部映射回思源里统一管理。后来发现没必要。个人博客最重要的是让写作和发布尽可能顺，而不是把所有工具强行揉成一个系统。

## 为什么我最后留在这套方案上

我最后没有继续折腾别的博客系统，原因其实很简单：这套东西足够轻，而且每个环节都比较稳。

- Hugo 很适合纯内容型博客
- Cloudflare Pages 部署基本不用操心
- 域名、证书、CDN 都在 Cloudflare 里统一处理
- 思源负责写作，体验比直接写 Markdown 文件舒服很多

更重要的是，它不会让我在“写文章之前”先进入一种搭环境的状态。

我现在只需要打开思源，写完，发布，等几分钟，文章就在 `evilstar.org` 上了。对我来说，这就够了。
