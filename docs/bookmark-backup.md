# Chrome 书签栏和 Bok 保存网页本地备份

本文档定义 Bok 0.0.10 的本地备份格式与执行规则。Chrome 书签栏、Bok 书签归档和
Bok 保存网页使用三个独立 JSON 文件，不会把 Chrome 书签写入标签页保存记录。每周
还会把这三个文件打包为一个 ZIP 历史快照。

## 范围

- 只备份 Chrome“书签栏”，不读取“其他书签”和“移动设备书签”。
- 备份标题、完整 URL、文件夹层级、原始排列顺序，以及 Chrome 可用的时间字段。
- 备份 `browser.storage.local.sessions` 中所有有效的 Bok 保存记录，包括当前和归档的
  session、标签组、标签页、任务状态、固定、锁定、标签和目录字段。
- 备份 `browser.storage.local.bookmarkArchiveStore` 中由用户明确归档的完整文件夹树。
- 用户通过设置页选择一个本机或 iCloud Drive 文件夹。
- 设置页可以导入 `bok-saved-pages.json` 和 `bok-bookmark-archive.json`；当前不支持
  直接导入 Chrome 书签备份或每周 ZIP。

## 文件名与格式

三个最新备份始终使用固定文件名：`bok-bookmarks.json`、`bok-saved-pages.json` 和
`bok-bookmark-archive.json`，每天覆盖上一份。归档或恢复文件夹时会立即重写并验证
归档文件。每日自动备份成功后当天不再执行。

每个自然周第一次成功备份时，Bok 会额外生成
`bok-weekly-backup-YYYY-MM-DD.zip`，其中包含上述三个 JSON。ZIP 文件名使用实际备份
日期，按名称保留最近 10 份；更早的 Bok 每周 ZIP 会自动删除。旧版本已经生成的
`bok-bookmarks-YYYY-MM-DD.json` 不会自动删除，但新版本不会继续生成这类日期文件。

```json
{
  "schemaVersion": 1,
  "kind": "bok-bookmarks-backup",
  "createdAt": "2026-08-09T12:00:00.000Z",
  "source": "bookmarks-bar",
  "counts": {
    "folders": 22,
    "bookmarks": 342
  },
  "bookmarksBar": {
    "title": "书签栏",
    "children": [
      {
        "title": "Example",
        "url": "https://example.com/path?query=1#section",
        "dateAdded": 1786276800000
      }
    ]
  }
}
```

节点不保存 Chrome `id`、`parentId` 或 `index`。父子数组表达层级和顺序；Chrome
节点 ID 不是跨恢复稳定标识。缺失的时间字段保持缺失，不用当前时间补齐。

`bok-saved-pages.json` 使用与保存页“导入 Bok 数据”相同的 schema v1 envelope：

```json
{
  "schemaVersion": 1,
  "revision": 8,
  "sessions": []
}
```

写入前会使用当前存储校验逻辑隔离损坏记录，因此文件只包含有效的保存记录，并可由
现有导入流程读取。导入时以分组 ID 为去重边界：当前已有的分组整组跳过，不在组内
合并标签页；同一会话中的新分组会追加到当前会话。

`bok-bookmark-archive.json` 保存独立的归档 envelope。归档节点只包含文件夹名称、
书签标题、完整 URL、层级和原始顺序；favicon 在展示时根据 URL 获取，不写入文件。
归档不保存或更新 `dateLastUsed`。恢复时 Chrome 会生成新的节点 ID 和创建时间。
导入归档备份时，每条记录都会生成新的归档 ID 并追加到归档库，不覆盖或去重当前归档。

## 本地状态

目录句柄保存在扩展源的 IndexedDB 数据库 `bok-bookmark-backup`。可序列化状态保存在
`browser.storage.local.bookmarkBackupState`：

- `directoryName`：Chrome 允许展示的文件夹名称，不是完整路径；
- `lastSuccessfulBackupAt` / `lastSuccessfulBackupDay`：最近一次成功时间和本地日期；
- `lastBackupFileName`：最近成功写入的 Chrome 书签文件名；
- `lastSavedPagesBackupFileName`：最近成功写入的 Bok 保存网页文件名；
- `lastArchiveBackupFileName`：最近成功写入的 Bok 书签归档文件名；
- `lastWeeklyBackupAt` / `lastSuccessfulWeeklyBackupWeek`：最近一次每周历史备份时间和
  对应自然周；
- `lastWeeklyBackupFileName`：最近成功写入的每周 ZIP 文件名；
- `lastAttemptAt` / `lastError`：最近一次尝试及失败原因。

当前 Chrome 书签栏内容不会复制到上述状态；只有用户明确归档的文件夹会存入独立的
`bookmarkArchiveStore`，确保从 Chrome 删除后仍能在 Bok 中浏览和恢复。

## 每日执行规则

1. 每次打开或激活 Bok 的标签页、书签或设置页面时请求后台执行。
2. 如果 `lastSuccessfulBackupDay` 是今天，立即跳过。
3. 如果今天尚未成功，检查目录句柄和写权限，生成三个最新 JSON 并覆盖固定文件。
4. 三个文件写入后都会重新读取完整内容进行字节级校验。
5. 如果本自然周还没有成功的历史备份，把三个 JSON 压缩为 ZIP，写入并校验后删除
   超出最近 10 份的旧 Bok 每周 ZIP。
6. 只有本次所需文件全部写入和校验成功才记录成功日期；任一步骤失败都保留失败状态。
7. 当天后续再次打开 Bok 时继续尝试，直到成功一次。

同时到达的请求共用一个后台任务，避免同一天并发写入。文件夹权限被 Chrome 撤销后，
后台不会自行弹窗；用户需要在设置页通过明确操作重新授权。
