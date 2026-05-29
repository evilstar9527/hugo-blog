---
title: "Publish Feature Architecture"
date: 2026-05-11
draft: false
categories: ["notes"]
---

## Publish Flow (User clicks "Publish")

```
                          Frontend (Next.js)
                               |
                    POST /api/projects/{id}/publish
                               |
                               v
                    +---------------------+
                    |   publish.py router  |
                    +---------------------+
                               |
                               v
                    +---------------------+
                    | publish_service.py   |
                    |                     |
                    | 1. Redis lock       |  lock:lifecycle:{project_id}
                    |    (lifecycle lock)  |  TTL=120s, mutex with sleep/wake
                    |                     |
                    | 2. Verify sandbox   |  session.status == "active"
                    |    is active        |
                    +---------------------+
                               |
              +----------------+----------------+
              |                                 |
              v                                 v
    +------------------+              +-------------------+
    |   E2B Sandbox    |              |       S3          |
    |                  |              |                   |
    | 3. npm run build |              | 5. Upload dist/*  |
    |    (Vite build)  |              |    to published/  |
    |                  |              |    {project_id}/  |
    | 4. find dist/    |              |                   |
    |    -type f       |  read bytes  | 6. Clean stale    |
    |                  | -----------> |    old files      |
    +------------------+              +-------------------+
                                              |
                                              v
                                    +-------------------+
                                    |   PostgreSQL      |
                                    |                   |
                                    | 7. Update Project |
                                    |  published_url    |
                                    |  published_at     |
                                    |  published_ver_id |
                                    +-------------------+
                                              |
                                              v
                                    Return {status, url, file_count}
```

## Routing State Machine (CF KV)

```
                    +------------------+
                    |  Sandbox Active  |
                    |                  |
                    | KV = {           |
                    |  url: e2b_proxy, |
                    |  sandbox_id: xxx |
                    | }                |
                    +--------+---------+
                             |
                 sleep_project() triggered
                 (sleep_checker / timeout)
                             |
              +--------------+--------------+
              |                             |
              v                             v
   +------------------+         +--------------------+
   | Hibernating      |         | Hibernating        |
   | (NOT published)  |         | (Published)        |
   |                  |         |                    |
   | KV = "SLEEPING"  |         | KV = {             |
   |                  |         |  published_url: S3,|
   | Shows wake page  |         |  sandbox_id: null  |
   +--------+---------+         | }                  |
            |                   |                    |
            |                   | CF Worker serves   |
            |                   | static from S3     |
            +--------+----------+--------------------+
                     |
            wake_project() triggered
            (user visits / API call)
                     |
                     v
            +------------------+
            |  Sandbox Active  |  KV overwritten by
            |  (proxy to e2b) |  register_cf_route()
            +------------------+
```

## S3 Upload Strategy (Safe Re-publish)

```
  Re-publish triggered
         |
         v
  +------------------+
  | 1. Build new     |     npm run build -> dist/
  |    dist files    |
  +------------------+
         |
         v
  +------------------+
  | 2. Upload ALL    |     PUT each file to S3
  |    new files     |     (overwrites existing same-name files)
  |    first         |     Wrapped in asyncio.to_thread()
  +------------------+
         |
         v
  +------------------+
  | 3. Collect       |     new_keys = set of all uploaded S3 keys
  |    new key set   |
  +------------------+
         |
         v
  +------------------+
  | 4. Delete STALE  |     List published/{id}/ prefix
  |    files only    |     Delete objects NOT in new_keys
  +------------------+
         |
         v
  At no point is the site fully down.
  Worst case mid-upload: mix of old + new files (briefly).
  Old-only files cleaned up last.
```

## Lock Coordination

```
  lock:lifecycle:{project_id}   (Redis, NX, TTL=120s)
  =============================
  Shared by:
    - wake_project()       mutex with sleep & publish
    - sleep_project()      mutex with wake & publish
    - publish_project()    mutex with wake & sleep

  Prevents:
    - sleep killing sandbox during publish
    - concurrent publishes
    - wake racing with sleep
```

## Key Files

```
apps/api/
  routers/publish.py              POST /projects/{id}/publish endpoint
  services/publish_service.py     Core logic: build -> upload -> update DB
  services/workspace_store.py     S3 helpers: put/delete published files
  services/sandbox_service.py     _set_sleeping_or_published() in sleep flow
  services/cf_kv.py               set_published_route() for KV routing
  models.py                       Project.published_url/at/version_id
  routers/projects.py             Publish fields in API + S3 cleanup on delete

apps/web/
  lib/api.ts                      publishProject() + ProjectInfo types
  app/project/[id]/page.tsx       Publish/Re-publish button + toast
  app/page.tsx                    Published badge in project list
```
