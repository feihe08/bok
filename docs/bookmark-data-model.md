# 书签数据结构

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

定义位于 `lib/types.ts`：

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

## Session 与分组

Bok 按一次保存操作记录一个 `SavedSession`，并用 `SavedGroup` 保留当时的分组关系：

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

export interface SavedGroup {
  id: string;
  title: string;
  createdAt: number;
  color?: SavedGroupColor;
  grouped: boolean;
  locked: boolean;
  pinned: boolean;
  archivedAt: number | null;
  taskStatus: 'todo' | 'doing' | 'done' | null;
  taskCompletedAt: number | null;
  tabs: SavedTab[];
}

export interface SavedSession {
  id: string;
  createdAt: number;
  groups: SavedGroup[];
}
```

层级关系为：

```text
SavedSession
└── SavedGroup[]
    └── SavedTab[]
```

`SavedGroup` 是通用容器，不等同于书签目录。本文严格区分以下两个概念：

- **分组**：`grouped: false`。点击 Bok 图标时，当前窗口中不属于 Chrome 标签组的
  标签会形成普通分组。普通分组名称允许为空和重复，不参与浏览器运行期同步。
- **标签组**：`grouped: true`。它对应 Chrome 原生标签组，名称必须非空且在所有 Bok
  记录的标签组中唯一。标签组始终按 Chrome 标签组打开，打开后参与运行期同步；同步
  资格只取决于 `grouped`，不依赖任务状态。

普通分组可以转换为标签组，标签组不能转回普通分组。转换只改变 Bok 记录，不会立即
打开浏览器标签；选择“以标签组打开”则先转换再打开。转换、以标签组打开或首次标记
为任务时，如果名称与已有标签组重复，使用“原名称 `YYYY/M/D HH:mm`”；若同一分钟仍
冲突，再追加数字。直接重命名标签组遇到重复名时拒绝保存。保存新的 Chrome 标签组
遇到名称冲突且不能按恢复规则认定为同一组时，依次使用“原名称 1”、“原名称 2”。
后台启动时会先用历史名称恢复运行期映射，再按创建时间从早到晚整理已有重名标签组：
较早的标签组保留原名，后续同名组使用数字后缀；已绑定的 Chrome 标签组同步改名。
普通分组不参与这项整理。

每个 `SavedTab` 仍然拥有自己的唯一目录。`color` 只允许 Chrome 支持的九种标签组
颜色。`locked: true` 表示该组可以重复打开，但不能删除整组或其中的单个标签，也不能
执行组内去重；锁定不影响重命名、归档、固定或任务标记。`pinned: true` 表示当前视图
置顶，并且自动归档跳过该组。`archivedAt` 是归档状态的唯一来源。

`taskStatus: null` 表示未标记为任务；用户主动将标签页或分组标记为任务时，第一次状态
固定为 `doing`，之后可以切换为 `todo`、`doing` 或 `done`。进入 `done` 时写入
`taskCompletedAt`，离开 `done` 或取消任务时清空。普通分组首次被标记为任务时还会按
上述唯一命名规则转换为标签组，但不会自动打开浏览器标签。取消任务不会把 `grouped`
改回 `false`。新保存的组默认 `locked: false`、`pinned: false`、`archivedAt: null`、
`taskStatus: null`、`taskCompletedAt: null`；来自 Chrome 标签组的记录使用
`grouped: true`，独立标签形成的普通分组使用 `grouped: false`。


## 单条 Session 示例

```json
{
  "id": "session-id",
  "createdAt": 1784563200000,
  "groups": [
    {
      "id": "group-id",
      "title": "Bok",
      "createdAt": 1784563200000,
      "color": "blue",
      "grouped": true,
      "locked": false,
      "pinned": false,
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
  ]
}
```

## 存储、校验与旧数据兼容

数据保存在 `browser.storage.local` 的 `sessions` key 中。当前存储版本为 v1，
顶层使用带版本号的 envelope，而不是直接保存数组：

```json
{
  "schemaVersion": 1,
  "revision": 3,
  "sessions": []
}
```

- `schemaVersion` 用来决定当前代码是否能够安全读取数据。
- `revision` 每次完整写入时递增，用于辨识数据快照。
- `sessions` 保存完整的 `SavedSession[]`。

旧版直接存储的 `SavedSession[]` 被视为 v0，仍可正常读取；第一次新增、修改或
删除记录时会写成 v1。若检测到高于当前支持范围的版本，Bok 会停止读取和写入，
避免旧版本扩展覆盖较新的数据。

读取 v1 时会校验 session、group 和 tab 的完整结构、字段类型及 ID 唯一性。某条
session 损坏时只跳过该条，其他有效 session 仍可使用；损坏原始数据、问题位置和
发现时间会追加保存到 `browser.storage.local` 的 `sessionsRecovery` key，且同一份
损坏数据不会重复写入。顶层结构损坏时无法安全拆分记录，因此会先保留整个原始值，
再停止加载。恢复副本不会被普通的 Bok 操作自动删除；只要恢复副本仍存在，保存页
就会持续提示，避免后台先完成隔离后用户不知道发生过异常。

`lib/storage.ts` 在读取时执行兼容转换：

- 旧的 `"Dev/Tools"` 目录转换为 `["Dev", "Tools"]`
- 缺失、空字符串或 `null` 目录转换为 `null`
- 缺失或非法标签转换为空数组
- 标签会去空、去重
- 缺失或非 `true` 的 `locked` 转换为 `false`
- 缺失或非 `true` 的 `pinned` 转换为 `false`
- 缺失或非法的组/标签页 `createdAt` 使用所属 session 或标签组的创建时间
- 缺失或非法的组/标签页 `archivedAt` 转换为 `null`
- 合法的 `taskStatus`（`todo`、`doing`、`done`）原样保留
- 合法的 `taskCompletedAt` 只在对应 `taskStatus === "done"` 时保留；其余情况、
  缺失值或非法值转换为 `null`，不会用当前时间伪造历史完成时间
- 旧 `status: "in-progress"` 转换为 `taskStatus: "doing"`，
  `status: "completed"` 转换为 `taskStatus: "done"`
- 旧 `status: "not-started"`、缺失状态或非法状态转换为 `taskStatus: null`，
  因为旧的“未开始”是默认值，不代表用户主动标记为任务
- 原有任务分组继续规范化为 `grouped: true`，以兼容任务分组按 Chrome 标签组打开的
  既有行为
- 后台启动时在恢复运行期映射后整理历史标签组名称，补齐空名称并按数字后缀消除重名；
  普通分组名称保持不变
- 非 Chrome 支持值的 `color` 转换为 `undefined`

兼容转换只发生在内存中。下一次新增、修改或删除记录时，规范化后的有效数据会随
v1 envelope 重新写入存储。

## 保存页操作与生命周期

保存页通过后台消息执行标签页删除和任务状态，以及分组转换、删除、重命名、锁定、
固定、归档/恢复、任务状态、组内去重和打开操作。
消息传输只负责校验、
排队和统一响应，具体命令由独立的操作执行器分发。所有保存和修改操作按顺序执行：

- 打开命令明确携带单一列表中目标组的完整 `tabIds`，并按原保存顺序创建；搜索
  只过滤渲染结果，不缩小打开范围。
- 目的地可以是保存页所在窗口或新窗口。新窗口通过 Chrome Windows API 创建。
- 普通打开不创建标签组，也不改变普通分组。普通分组选择“以标签组打开”时先永久转换
  为标签组；名称冲突按时间规则改名。标签组打开会恢复唯一名称和颜色，无显式名称时
  使用“`N` 个标签页”，无有效颜色时使用 `grey`。
- 普通分组的更多操作菜单提供“转换为标签组”；转换后不提供反向操作。标签组直接
  重命名时会检查全局标签组名称，重复名会返回错误。
- 创建完成后激活第一条标签页。
- 点击单个标签或普通打开只创建浏览器标签，不改写保存数据。打开 `grouped: true` 的
  标签组时，如果发现满足恢复条件的现有 Chrome 标签组，会先执行无损并集合并。只有
  明确执行删除或组内去重时才会主动移除 Bok 数据。
- `grouped: true` 的标签组始终以 Chrome 标签组形式打开。打开成功后，后台在当前
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
- 任一步骤失败时停止后续操作，不回滚已经打开的标签页，并保留 Bok 记录。
  错误会包含已打开数量。空选择不能打开，也会保留。
- 存储层会在删除标签或整组前重新读取记录；锁定组的删除请求会明确失败。

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

## 归档与组内去重

- 归档只写入标签组的时间戳，不删除数据，也不改写标签页的兼容归档字段。
- `group.archivedAt === null` 表示当前组，非空表示已归档组。保存页默认展示当前组，
  归档视图展示已归档组并提供恢复操作。
- 手动归档不检查年龄、任务状态或固定状态。固定组手动归档时，同一次写入先设置
  `pinned: false`，再写入 `archivedAt`；恢复只清空 `archivedAt`，不会重新固定。
- 自动归档由 Chrome alarms 每小时触发，并在后台启动时补充执行。只有创建至少
  72 小时、组和所有标签页均为 `taskStatus: null`、`pinned: false` 且尚未归档的组
  才符合条件。设备休眠期间不会主动唤醒，恢复运行后再检查。
- 固定组在当前视图置顶；固定与锁定是两个独立状态。
- 组内去重只检查目标组。比较键为 `new URL(url).href` 的完整规范 URL，查询
  参数和 hash 都参与比较；历史坏 URL 回退为去除首尾空格的原字符串。
- 重复时保留组内第一条记录，返回移除数量。锁定组拒绝去重。

## Chrome 书签栏映射

当前数据模型已经能够表达 Chrome 书签栏路径，但写入 Chrome Bookmarks API
的功能尚未实现。

实现同步时必须遵守：

- `directory` 的每个路径段依次映射为书签栏下的一层文件夹。
- `tags` 不映射为 Chrome 文件夹，也不创建重复书签。
- `directory: null` 的书签不能静默选择目录，应先由用户指定。
- 创建或移动 Chrome 书签成功后，才可以把本地状态视为已同步。
- 不应硬编码 Chrome 书签栏的节点 ID，应通过 Bookmarks API 查找书签栏根节点。

## 修改检查清单

修改本数据结构时，至少同步检查：

1. `lib/types.ts` 中的类型定义
2. `lib/model.ts` 中的核心模型
3. `lib/save-tabs.ts` 中的新记录初始化
4. `lib/storage.ts` 中的旧数据兼容与读写逻辑
5. 保存记录页面的读取与编辑逻辑
6. Chrome 书签同步和归档逻辑
7. `pnpm compile`
8. `pnpm build`
