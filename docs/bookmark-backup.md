# Bok 本地备份

本文档定义 Bok 的本地备份格式与执行规则。备份按数据是否随电脑变化分为两部分：
Saved pages 和当前设置按机器名称隔离；Chrome 书签栏和 Bok 书签归档写入共享目录。
共享目录只是用户所选文件夹中的备份，不等同于 Bok 实时同步。

## 范围

- 只备份 Chrome“书签栏”，不读取“其他书签”和“移动设备书签”。
- 备份标题、完整 URL、文件夹层级、原始排列顺序，以及 Chrome 可用的时间字段。
- 备份 `browser.storage.local.sessions` 中所有有效的 Bok 保存记录，包括当前和归档的
  Session、真实 Chrome 标签组和独立标签，以及 Session/Group/Tab 的任务状态、
  Session/Group 的固定与锁定、Chrome Group 颜色、标签和目录字段。
- 备份 `browser.storage.local.bookmarkArchiveStore` 中由用户明确归档的完整文件夹树。
- 用户通过设置页选择一个本机或 iCloud Drive 文件夹，并为当前电脑设置唯一的机器名称。
- 备份当前自动归档周期和主题设置。
- 设置页可以导入 `bok-saved-pages.json` 和 `bok-bookmark-archive.json`；当前不支持
  直接导入设置、Chrome 书签备份或每周 ZIP。

## 目录布局

假设当前机器名称为 `personal`：

```text
<用户选择的文件夹>/
  devices/
    personal/
      device.json
      bok-saved-pages.json
      bok-settings.json
      history/
        bok-device-weekly-backup-personal-GENERATION-YYYY-MM-DD.zip
  shared/
    bok-bookmarks.json
    bok-bookmark-archive.json
    history/
      bok-shared-weekly-backup-personal-GENERATION-YYYY-MM-DD.zip
```

`devices/personal/` 只由名称为 `personal` 且持有匹配归属信息的安装写入。共享目录中的
两个最新 JSON 使用固定文件名；多台电脑写入时，以文件系统最终完成的写入为准。共享
周包包含写入设备名称和认领代次，避免重命名或重新绑定覆盖已有周包。

每个自然周第一次成功备份时，本机数据和共享数据分别生成一个 ZIP。每台电脑只清理
与自己名称匹配的周包，各保留最近 10 份，不删除其他电脑、旧版本或非 Bok 文件。
旧版本已经生成在根目录的 JSON 和 ZIP 不会被迁移、覆盖或自动删除。

## 机器名称与归属

- 名称使用 1–32 个小写字母、数字、`-` 或 `_`；输入会先去除首尾空格并转为小写。
- 名称是 `devices/<name>/` 的目录 key，在同一个备份根目录中必须唯一。
- 本机生成一个不在设置界面展示的随机 `claimId`；`device.json` 保存名称和 claim，用于
  防止两台电脑意外使用同一个 key。
- 每次备份前都会重新验证 claim。名称已被其他安装占用时不会写入 Saved pages 或设置。
- “重新绑定此名称”会在用户确认后生成新 claim；旧安装之后会因为归属不匹配而停止写入。
- 不同认领代次的周包使用不同文件名；重新绑定不会覆盖旧代次已有的周包。
- 重命名会创建并认领新目录，旧目录和旧快照保留，不自动删除。
- 机器名称是独立的本机设置，claim 属于备份运行状态；两者都不进入 `bok-settings.json`。
- 未选择或未授权备份目录时，机器名称仍可保存；下次取得目录写入权限时再检查重名。

## 文件格式

`bok-bookmarks.json` 使用独立的 Chrome 书签栏 envelope：

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

`bok-saved-pages.json` 使用与保存页“导入 Bok 数据”相同的 schema v3 envelope：

```json
{
  "schemaVersion": 3,
  "revision": 8,
  "sessions": []
}
```

写入前会使用当前存储校验逻辑隔离损坏记录，因此文件只包含有效的保存记录，并可由
现有导入流程读取。每个 Session 只使用有序 `items`：direct tab 直接作为 tab item，
Group 只表示 `grouped: true` 的真实 Chrome 标签组并保留 `color`。文件不写入
`layout`、`legacyGroups` 或运行期 groups proxy。

v1/v2 备份仍可导入，但会在导入过程中迁移到 v3，不会以 legacy 结构继续操作。
旧 `grouped: false` 普通分组各自变为仅含 direct tabs 的独立 Session；混合记录中的
真实 Chrome Group 保留在原 Session 并维持可确定的原顺序。首次把本机旧数据写为
v3 前，完整原始值保存在 `sessionsPreV3Snapshot`，不覆盖已有快照。

`bok-settings.json` 使用独立的严格 envelope：

```json
{
  "schemaVersion": 1,
  "kind": "bok-settings-backup",
  "createdAt": "2026-08-15T12:00:00.000Z",
  "settings": {
    "savedPagesAutoArchivePeriod": 7,
    "theme": "dark"
  }
}
```

`savedPagesAutoArchivePeriod` 为 `1`、`3`、`7`、`30` 或 `"never"`；`theme` 为
`"system"`、`"light"` 或 `"dark"`。文件不包含机器名称、claim、目录句柄、Chrome
权限、最近备份状态、导入副本或恢复副本。

`bok-bookmark-archive.json` 保存独立的归档 envelope。归档节点只包含文件夹名称、
书签标题、完整 URL、层级和原始顺序；favicon 在展示时根据 URL 获取，不写入文件。
归档不保存或更新 `dateLastUsed`。恢复时 Chrome 会生成新的节点 ID 和创建时间。
导入归档备份时，每条记录都会生成新的归档 ID 并追加到归档库，不覆盖或去重当前归档。
归档和恢复操作仍会在修改 Chrome 书签前后立即写入并验证共享归档备份，以维持现有的
防丢失约束；其他电脑不会因此自动读取或合并其本地归档库。

## 本地状态

目录句柄保存在扩展源的 IndexedDB 数据库 `bok-bookmark-backup`。机器名称和 claim
分别保存在 `browser.storage.local.backupDeviceName` 与 `backupDeviceClaimId`。可序列化
状态保存在 `browser.storage.local.bookmarkBackupState`：

- `directoryName`：Chrome 允许展示的文件夹名称，不是完整路径；
- `lastSuccessfulBackupAt` / `lastSuccessfulBackupDay`：最近一次成功时间和本地日期；
- `deviceName`：当前电脑使用的机器名称；
- `lastBackupFileName`：最近成功写入的共享 Chrome 书签文件路径；
- `lastSavedPagesBackupFileName`：最近成功写入的本机 Bok 保存网页文件路径；
- `lastSettingsBackupFileName`：最近成功写入的本机设置文件路径；
- `lastArchiveBackupFileName`：最近成功写入的 Bok 书签归档文件名；
- `lastWeeklyBackupAt` / `lastSuccessfulWeeklyBackupWeek`：最近一次每周历史备份时间和
  对应自然周；这些字段记录本机周包；
- `lastWeeklyBackupFileName`：最近成功写入的本机周包路径；
- `lastSharedWeeklyBackupAt` / `lastSuccessfulSharedWeeklyBackupWeek` /
  `lastSharedWeeklyBackupFileName`：最近一次共享周包状态；
- `lastAttemptAt` / `lastError`：最近一次尝试及失败原因。

当前 Chrome 书签栏内容不会复制到上述状态；只有用户明确归档的文件夹会存入独立的
`bookmarkArchiveStore`，确保从 Chrome 删除后仍能在 Bok 中浏览和恢复。

## 每日执行规则

1. 每次打开或激活 Bok 的标签页、书签或设置页面时请求后台执行；设置变化会请求强制备份。
2. 如果当前名称、当天成功状态、本机/共享文件路径和两类周包状态都匹配，普通请求跳过。
3. 检查目录句柄、写权限和当前 claim；冲突时停止，不写入本机数据。
4. 生成本机 Saved pages、设置，以及共享 Chrome 书签栏、书签归档四份最新 JSON。
5. 每个文件写入后都重新读取完整内容进行字节级校验。
6. 本自然周尚未成功时，分别生成本机周包和共享周包，并只清理当前名称超出最近 10 份
   的对应周包。
7. 只有本次所需文件全部写入和校验成功才记录成功日期；任一步骤失败都保留失败状态。
8. 当天后续再次打开 Bok 时继续尝试，直到成功一次；`force` 请求不受当天成功状态限制。

同时到达的请求共用一个后台任务，避免同一天并发写入。文件夹权限被 Chrome 撤销后，
后台不会自行弹窗；用户需要在设置页通过明确操作重新授权。
