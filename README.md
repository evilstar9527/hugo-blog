# Hugo Blog

这是一个最小化的 Hugo 静态博客，用于配合：

- 思源：写作和本地持久化
- GitHub：保存 Markdown、主题和静态资源
- Cloudflare Pages：自动构建和部署
- Hugo + hugo-texify3：渲染静态站点

## Local Development

```sh
npm install
npm run dev
```

本地构建：

```sh
npm run build
```

## Content Layout

```text
content/posts/      # 思源发布插件提交 Markdown 到这里
static/uploads/     # 图片、附件等静态资源
themes/hugo-texify3 # 主题源码，直接纳入本仓库，不使用 submodule
```

文章 frontmatter 至少包含：

```yaml
---
title: "文章标题"
date: 2026-05-09T12:00:00+08:00
draft: false
---
```

## Writing

新建文章：

```sh
hugo new content posts/my-first-post.md
```

文章会生成在 `content/posts/`。写完后本地预览：

```sh
npm run dev
```

发布：

```sh
git add content/posts static/uploads
git commit -m "publish post"
git push
```

推送到 `main` 后，Cloudflare Pages 会自动重新构建。

## Cloudflare Pages

推荐配置：

- Framework preset: `Hugo`
- Production branch: `main`
- Build command: `npm ci && hugo --gc --minify -b "$CF_PAGES_URL"`
- Build output directory: `public`
- Root directory: 留空
- Environment variable: `HUGO_VERSION=0.161.1`

绑定正式域名后，可以把 `hugo.toml` 中的 `baseURL` 改为正式域名。
