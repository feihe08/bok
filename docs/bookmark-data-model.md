# 书签数据结构

> 状态说明：本文记录的是将 Bok 标签页记录进一步转换为带标签书签的旧设计，
> 不属于 0.0.5 之后的 Chrome 书签管理与本地备份功能。当前书签管理直接以
> `chrome.bookmarks` 为唯一数据源，不读取或写入本文的 `SavedTab.tags`、
> `SavedTab.directory` 或 `sessions`。本地备份格式另见
> [`docs/bookmark-backup.md`](./bookmark-backup.md)。本文字段仅为兼容保留，后续另行评估。

本文档是 Bok 书签数据模型的唯一说明。修改书签字段、存储格式或 Chrome
书签同步逻辑时，应先更新本文档。

## 设计目标

每个书签必须能够保存：

- 链接
- 标题
- 更新时间
- 由用户指定的多个标签
- 最多一个目录，目录可以有多级

标签只用于 Bok 内部分类，不会因为一个书签有多个标签而在 Chrome 中创建多份
书签。目录表示书签在 Chrome 书签栏下的唯一位置。

## 核心类型

定义位于 `libs/saved-pages/model.ts`。该文件是 saved-pages 功能唯一的数据模型：

```ts
export type DirectoryPath = [string, ...string[]];

export interface SavedTab {
  id: string;
  url: string;
  title: string;
  favIconUrl?: string;
  createdAt: number;
  updatedAt: number;
  tags: string[];
  directory: DirectoryPath | null;
  taskStatus: 'todo' | 'doing' | 'done' | null;
  taskCompletedAt: number | null;
  archivedAt: number | null;
}
```

### 字段语义

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `string` | Bok 内部生成的书签唯一标识 |
| `url` | `string` | 书签链接 |
| `title` | `string` | 书签标题；标签页没有标题时使用 URL |
| `favIconUrl` | `string \| undefined` | 可选的网站图标地址 |
| `createdAt` | `number` | Unix 毫秒时间戳；标签页首次进入 Bok 的时间 |
| `updatedAt` | `number` | Unix 毫秒时间戳；首次保存时写入当前时间，后续修改书签信息时也必须更新 |
| `tags` | `string[]` | 用户指定的标签；允许为空，不自动生成 |
| `directory` | `DirectoryPath \| null` | 唯一目录路径；`null` 表示用户尚未指定目录 |
| `taskStatus` | `'todo' \| 'doing' \| 'done' \| null` | 标签页任务状态；`null` 表示普通标签页 |
| `taskCompletedAt` | `number \| null` | 当前任务进入 `done` 的 Unix 毫秒时间戳；任务离开 `done` 或取消后为 `null` |
| `archivedAt` | `number \| null` | 旧数据兼容字段；新的归档状态只读取标签组的 `archivedAt` |

## 标签约束

- 一个书签可以有零个或多个标签。
- 标签由用户明确指定，保存标签页时默认是空数组。
- 标签读取时会去除首尾空格、空标签和重复标签。
- 标签顺序保留用户第一次指定时的顺序。

示例：

```json
["AI", "Research", "Read Later"]
```

## 目录约束

`DirectoryPath` 是一个非空路径段数组。每个元素对应 Chrome 书签栏下的一层
文件夹：

```json
["Dev", "Tools"]
```

它表示：

```text
Chrome 书签栏
└── Dev
    └── Tools
        └── 当前书签
```

必须遵守以下规则：

- 一个书签只能有一个 `directory` 字段，因此不会同时属于多个目录。
- 已指定的目录至少包含一个非空路径段。
- 未指定目录使用 `null`，不能省略字段，也不能用空字符串表示。
- 路径使用数组而不是 `"Dev/Tools"` 字符串，避免文件夹名称本身包含 `/` 时产生歧义。
- Chrome 同步时，目录路径相对于书签栏根节点，不包含“书签栏”本身。

## Session、Chrome Group 与 Tab

Bok 的持久化域模型只有 `SavedSession`、`SavedGroup` 和 `SavedTab`。每次保存
当前窗口生成一个有序 `SavedSession`；`items` 严格保留 Chrome 标签栏顺序，
独立标签直接保存为 tab item，Group 只表示真实 Chrome 标签组：

```ts
export type SavedGroupColor =
  | 'blue'
  | 'cyan'
  | 'green'
  | 'grey'
  | 'orange'
  | 'pink'
  | 'purple'
  | 'red'
  | 'yellow';

export type SavedPagesAutoArchivePeriod = 1 | 3 | 7 | 30 | 'never';

export interface SavedGroup {
  id: string;
  title: string;
  createdAt: number;
  color?: SavedGroupColor;
  grouped: true;
  locked: boolean;
  pinned: boolean;
  restoredAt: number | null;
  archivedAt: number | null;
  taskStatus: 'todo' | 'doing' | 'done' | null;
  taskCompletedAt: number | null;
  tabs: SavedTab[];
}

export type SavedSessionItem =
  | { type: 'tab'; tab: SavedTab }
  | { type: 'group'; group: SavedGroup };

export interface SavedSession {
  id: string;
  createdAt: number;
  title: string;
  locked: boolean;
  pinned: boolean;
  restoredAt: number | null;
  archivedAt: number | null;
  taskStatus: 'todo' | 'doing' | 'done' | null;
  taskCompletedAt: number | null;
  items: SavedSessionItem[];
}
```

上面是当前公开模型和持久化结构。新存储不包含 `layout`、`legacyGroups`
或为独立标签派生的运行期 groups proxy。

层级关系为：

```text
SavedSession
└── SavedSessionItem[]
    ├── tab -> SavedTab
    └── group -> SavedGroup -> SavedTab[]

```

`SavedGroup` 不等同于书签目录，也不是通用容器。本文严格区分以下概念：

- **独立标签**：新保存记录中直接使用 `type: 'tab'`，不再为了展示而合并成普通分组。
- **标签组**：`grouped` 固定为 `true`。它对应 Chrome 原生标签组，保留名称和
  `color`；名称必须非空且在所有 Bok 记录的标签组中唯一。标签组始终
  按 Chrome 标签组打开，打开后参与运行期同步；同步资格不依赖任务状态。

直接重命名标签组遇到重复名时拒绝保存。保存新的 Chrome 标签组
遇到名称冲突且不能按恢复规则认定为同一组时，依次使用“原名称 1”、“原名称 2”。
后台启动时会先用历史名称恢复运行期映射，再按创建时间从早到晚整理已有重名标签组：
较早的标签组保留原名，后续同名组使用数字后缀；已绑定的 Chrome 标签组同步改名。

每个 `SavedTab` 仍然拥有自己的唯一目录。`color` 只允许 Chrome 支持的九种标签组
颜色。Session 和 Group 都拥有 `locked`、`pinned`、`restoredAt`、`archivedAt`、
`taskStatus` 和 `taskCompletedAt`；Session 另有可编辑的 `title`。空标题在界面上
回退为“X 个标签”。Session 的固定、归档、任务和锁定只修改 Session 本身，
不批量改写子 Group。

`locked: true` 不影响重命名、归档、固定、任务标记或打开。Session 锁定时
不能删除整个 Session 或其独立标签；任一子 Group 锁定时也不允许删除整个
Session。Group 锁定时不能删除该组或组内标签，也不能组内去重。`pinned: true`
表示固定并让自动归档跳过该对象；Session 内仍保持原始 item 顺序，不因固定或
筛选重排。`restoredAt` 记录最近一次手动恢复时间；自动归档会从 `createdAt`
与 `restoredAt` 中较晚的时间重新计算所选周期。`archivedAt` 是对应对象
归档状态的唯一来源。

`taskStatus: null` 表示未标记为任务；用户主动将 Session、标签页或 Group 标记为任务时，第一次状态
固定为 `doing`，之后可以切换为 `todo`、`doing` 或 `done`。进入 `done` 时写入
`taskCompletedAt`，离开 `done` 或取消任务时清空。新保存的 Session 和 Group
默认 `locked: false`、`pinned: false`、`restoredAt: null`、`archivedAt: null`、
`taskStatus: null`、`taskCompletedAt: null`。独立标签不会生成 Group，其 Session
提供整体状态和操作。

只包含一个真实 Chrome Group 的 Session 可以在界面上视觉合并为一层，但这不会
改变数据层级：Session 仍包含一个 group item，Session 命令和 Group 命令仍分别作用。


## 单条 Session 示例

```json
{
  "id": "session-id",
  "createdAt": 1784563200000,
  "title": "",
  "locked": false,
  "pinned": false,
  "restoredAt": null,
  "archivedAt": null,
  "taskStatus": null,
  "taskCompletedAt": null,
  "items": [
    {
      "type": "tab",
      "tab": {
        "id": "standalone-tab-id",
        "url": "https://example.com",
        "title": "Example",
        "createdAt": 1784563200000,
        "updatedAt": 1784563200000,
        "tags": [],
        "directory": null,
        "taskStatus": null,
        "taskCompletedAt": null,
        "archivedAt": null
      }
    },
    {
      "type": "group",
      "group": {
        "id": "group-id",
        "title": "Bok",
        "createdAt": 1784563200000,
        "color": "blue",
        "grouped": true,
        "locked": false,
        "pinned": false,
        "restoredAt": null,
        "archivedAt": null,
        "taskStatus": "doing",
        "taskCompletedAt": null,
        "tabs": [
          {
            "id": "bookmark-id",
            "url": "https://developer.chrome.com/docs/extensions/reference/api/bookmarks",
            "title": "Chrome Bookmarks API",
            "favIconUrl": "https://developer.chrome.com/favicon.ico",
            "createdAt": 1784563200000,
            "updatedAt": 1784563200000,
            "tags": ["Chrome", "Extension"],
            "directory": ["Dev", "Tutorials"],
            "taskStatus": null,
            "taskCompletedAt": null,
            "archivedAt": null
          }
        ]
      }
    }
  ]
}
```

## 存储、校验与旧数据兼容

数据保存在 `browser.storage.local` 的 `sessions` key 中。当前存储版本为 v3，
顶层使用带版本号的 envelope，而不是直接保存数组：

```json
{
  "schemaVersion": 3,
  "revision": 3,
  "sessions": []
}
```

- `schemaVersion` 用来决定当前代码是否能够安全读取数据。
- `revision` 每次完整写入时递增，用于辨识数据快照。
- `sessions` 保存完整的 v3 `SavedSession[]`；不会写入 `legacyGroups`。

自动归档周期独立保存在 primitive key `savedPagesAutoArchivePeriod` 中，可选值为
`1`、`3`、`7`、`30` 或 `"never"`。缺失或非法值回退为默认的 `7` 天；`30` 按
30 × 24 小时计算，`"never"` 表示永不自动归档。

旧版直接存储的 `SavedSession[]` 被视为 v0，v1/v2 envelope 也可正常读取。迁移时：

- v0/v1/v2 中每个 `grouped: false` 的旧普通分组都拆成一个仅含 direct tab items
  的独立 Session，保留该组的标题、创建时间、标签顺序和状态。
- 原 Session 中存在 direct tab 或 `grouped: true` 的真实 Chrome Group 时，它们仍按原顺序
  保留在原 Session；只把旧普通分组分别拆出。
- 真实 Chrome Group 写为 group item，`grouped` 固定为 `true`；迁移结果不保留
  `layout`、`legacyGroups` 或运行期 groups proxy。

第一次写成 v3 前，Bok 会把完整原始值保存到 `sessionsPreV3Snapshot`，
已有快照不会被覆盖。旧版本
扩展遇到 v3 时会停止读取和写入，避免覆盖较新的数据；重新升级到支持 v3 的版本后可继续使用。

Saved pages 存储属于当前机器。不同机器可以分别保留 v1、v2 或 v3 备份；升级和首次写入
互不影响。导入另一台机器的数据时，v1/v2 会先迁移到 v3，再按 session 合并，不会替换本机全部记录。

读取 v0/v1/v2/v3 时会校验 session、item、group 和 tab 的完整结构、字段类型及 ID 唯一性。某条
session 损坏时只跳过该条，其他有效 session 仍可使用；损坏原始数据、问题位置和
发现时间会追加保存到 `browser.storage.local` 的 `sessionsRecovery` key，且同一份
损坏数据不会重复写入。顶层结构损坏时无法安全拆分记录，因此会先保留整个原始值，
再停止加载。恢复副本不会被普通的 Bok 操作自动删除；只要恢复副本仍存在，保存页
就会持续提示，避免后台先完成隔离后用户不知道发生过异常。

`libs/saved-pages/persistence.ts` 在读取时执行兼容转换：

- 旧的 `"Dev/Tools"` 目录转换为 `["Dev", "Tools"]`
- 缺失、空字符串或 `null` 目录转换为 `null`
- 缺失或非法标签转换为空数组
- 标签会去空、去重
- Session 或组缺失、非 `true` 的 `locked` 和 `pinned` 转换为 `false`
- Session 或组缺失的 `restoredAt` 和 `archivedAt` 转换为 `null`；需要严格
  校验的字段遇到非 `null` 且非有限数字时按损坏记录隔离
- 缺失或非法的组/标签页 `createdAt` 使用所属 session 或标签组的创建时间
- 缺失或非法的组/标签页 `archivedAt` 转换为 `null`
- 合法的 `taskStatus`（`todo`、`doing`、`done`）原样保留
- 合法的 `taskCompletedAt` 只在对应 `taskStatus === "done"` 时保留；其余情况、
  缺失值或非法值转换为 `null`，不会用当前时间伪造历史完成时间
- 旧 `status: "in-progress"` 转换为 `taskStatus: "doing"`，
  `status: "completed"` 转换为 `taskStatus: "done"`
- 旧 `status: "not-started"`、缺失状态或非法状态转换为 `taskStatus: null`，
  因为旧的“未开始”是默认值，不代表用户主动标记为任务
- 后台启动时在恢复运行期映射后整理历史标签组名称，补齐空名称并按数字后缀消除重名；
- 非 Chrome 支持值的 `color` 转换为 `undefined`

兼容转换发生在读取时。下一次新增、修改或删除记录时，规范化后的有效数据会随
schema v3 envelope 重新写入存储，并先按上述规则保留 `sessionsPreV3Snapshot`。

## 保存页操作与生命周期

保存页通过后台消息执行 Session 的打开全部、删除、重命名、固定、归档/恢复、
任务状态和锁定，以及 Chrome Group 和 Tab 已有的对应操作。
消息传输只负责校验、
排队和统一响应，具体命令由独立的操作执行器分发。所有保存和修改操作按顺序执行：

- `open-session` 始终读取完整持久化 Session，不受搜索或当前渲染筛选影响。
  direct tab 和多个 Chrome Group 按 `items` 顺序还原；标签组保留名称和颜色。
- 目的地可以是保存页所在窗口或新窗口。打开到当前窗口时，整个 Session
  作为连续块追加；新窗口会复用创建窗口产生的首个 tab，不重复打开首条记录。
  创建完成后激活第一条标签页。
- 仅含一个 Chrome Group 的 Session 若已有活跃绑定，打开 Session 会聚焦已有组。
  包含多个 item 的 Session 若任一子 Group 已有活跃绑定，则在创建任何新 tab
  之前拒绝整次打开，避免部分重复。
- Chrome Group 打开后，后台在当前
  浏览器会话中绑定 Chrome 标签组与原 Bok 标签组；再次打开已有活跃绑定时聚焦原组，
  不创建副本。任务状态不参与同步资格判断，取消任务后绑定继续生效。
- 活跃同步组中加入或移出的单个标签会同步新增或删除原 Bok 分组记录；单个标签
  被关闭时也会同步删除。该自动成员同步不受 `locked` 限制，`locked` 仍只阻止从
  Bok 页面主动删除和去重。
- 活跃同步组内标签的 URL、标题和顺序变化通过标签更新与移动事件防抖写回 Bok；
  新标签先产生的 `chrome://newtab/` 临时快照会在实际导航完成后更新为最终地址。
- 浏览器标签组被整体删除、关闭，或其所在窗口被整体关闭时，只解除当前运行期
  绑定，不删除 Bok 记录。
- 点击 Bok 执行“保存并关闭”时，活跃同步组先把当前成员、URL、标题、组名和颜色
  写回原分组，再随窗口中的其他标签一起关闭；浏览器确认关闭后才解除绑定。若关闭
  失败，仍然打开的同步组继续同步。这些标签不会写入新的 session，因此不会
  产生重复保存记录。
- 保存尚未绑定的 Chrome 标签组前，也先执行恢复匹配。同名且重合率严格大于 50% 时
  合并到已有标签组，不创建新记录；重合率小于或等于 50% 时创建新标签组，并用数字
  后缀保证名称唯一。同一次保存中的多个 Chrome 标签组也共用这套名称占用检查。
- 活跃 Chrome 标签组被改成其他标签组已使用的名称时，Bok 使用时间后缀改成唯一名称，
  并把最终名称同步回 Chrome。
- Session 打开过程中的任一创建或绑定步骤失败时，Bok 记录保持不变；尽量删除
  本次创建的 tabs 或新窗口，回滚也失败时明确报错。
- 删除 Session 会精确清理其所有运行期同步绑定，但不关闭已打开的 Chrome tabs。
  Session 已锁定或包含任一已锁定 Group 时拒绝删除。

同步标签组的 Chrome `tabId` 和 `tabGroupId` 只在当前浏览器会话有效，运行期绑定
保存在 `browser.storage.session`。浏览器完整重启或映射丢失后，按以下规则恢复：

- Chrome 标签组名称必须与 Bok 标签组名称相同；比较时忽略名称首尾空格。
- “相同标签”按完整 URL 的多重集合交集计算，重复 URL 按出现次数分别计数。
- 重合率为 `相同标签数 / max(Bok 标签数, Chrome 标签数)`，必须严格大于 50%。
- 同一 Bok 组或 Chrome 组出现同分候选时视为歧义，不自动绑定；非同分候选选择
  重合率最高、其次相同标签数最多的一组。
- 恢复成功后做无损并集合并：保留 Chrome 当前顺序，Chrome 独有标签写入 Bok，
  Bok 独有标签追加打开到原 Chrome 标签组，然后建立新的标签 ID 映射。
- 重合率小于或等于 50%（包括恰好 50%）不能恢复为同一组；后续保存时按新标签组
  处理，并在名称冲突时追加数字后缀。
- 扩展后台启动时尝试恢复；Chrome 延迟恢复标签组或标签加载完成时会防抖重试，
  用户从 Bok 打开已标记分组前也会再做一次兜底恢复。

## 保存网页的归档与组内去重

- 归档与恢复不会删除数据，也不改写标签页的兼容归档字段。
- Session 和 Group 各自以自身的 `archivedAt` 作为归档状态唯一来源。保存页
  默认展示当前视图，归档视图展示已归档对象并提供恢复操作。
- 手动归档不检查年龄、任务状态或固定状态。固定 Session 或 Group
  手动归档时，同一次写入先设置 `pinned: false`，再写入 `archivedAt`。
  恢复会清空 `archivedAt` 并把当前时间写入
  `restoredAt`，不会修改 `createdAt` 或重新固定；再次手动归档保留 `restoredAt`。
- 自动归档由 Chrome alarms 每小时触发，并在后台启动时补充执行。周期可设为 1、3、
  7、30 天或永不，默认 7 天。自动归档处理仅含 direct tab items 的 Session，
  以及每个真实 Chrome Group；混合 Session 的 Group 各自判定，不自动归档整个
  混合 Session。只有距 `max(createdAt, restoredAt ?? createdAt)` 严格超过所选周期、
  对象和所有相关标签均不处于 `todo` 或 `doing`、`pinned: false` 且尚未归档
  时才符合条件；`done` 和未标记任务的对象可以自动归档。设备休眠期间不会主动
  唤醒，恢复运行后再检查。修改设置后会立即按新周期执行一次检查，但不会改变已经
  归档的组。
- 固定对象跳过自动归档，但不改变 Session 内顺序；固定与锁定是两个独立状态。
- 组内去重只检查目标组。比较键为 `new URL(url).href` 的完整规范 URL，查询
  参数和 hash 都参与比较；历史坏 URL 回退为去除首尾空格的原字符串。
- 重复时保留组内第一条记录，返回移除数量。锁定组拒绝去重。

## Chrome 书签栏与独立归档库

Chrome 书签管理直接以 Chrome Bookmarks API 返回的书签栏为事实来源，不读取或写入
`SavedTab.tags`、`SavedTab.directory` 或 `sessions`。保存网页与 Chrome 书签是两个
独立一级能力。

用户明确归档文件夹时，Bok 把完整文件夹树写入
`browser.storage.local.bookmarkArchiveStore`。归档记录只保存文件夹名称、书签标题、
完整 URL、层级、顺序、原父目录提示和事务状态；不保存 favicon、最后访问时间，也不把
Chrome 节点 ID 当作恢复后的稳定身份。只有固定归档文件写入并校验成功后，才调用
`bookmarks.removeTree` 从 Chrome 删除原文件夹。

恢复会按快照重新创建内容。全部创建并校验成功后才移除本地归档记录；失败时保留归档，
并只清理由本次恢复新建的根文件夹。Chrome 可能为恢复内容生成新的节点 ID 和创建时间。

书签整理尚未实现。当前页面只保留未启用的整理按钮，不会分析重复或死链，也不会
自动触发删除、移动或合并。

## 修改检查清单

修改本数据结构时，至少同步检查：

1. `libs/saved-pages/model.ts` 中的核心类型定义
2. `libs/saved-pages/save-tabs.ts` 中的新记录初始化
3. `libs/saved-pages/persistence.ts` 中的旧数据兼容与读写逻辑
4. 保存记录页面的读取与编辑逻辑
5. Chrome 书签同步和归档逻辑
6. `pnpm compile`
7. `pnpm build`
