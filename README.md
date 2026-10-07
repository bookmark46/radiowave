# 无意识电波 · App 前端

SillyTavern 客户端扩展。为世界观卡《无意识电波》提供一套手机 App 形态的前端界面。

> 这是**扩展**，不是角色卡。角色卡见 Releases / 发行包里的 `无意识电波.png`。

## 功能

- **五界面 App**：主页 / 档案 / 电波 / 地图 / 设置，在聊天界面通过悬浮按钮打开
- **动态人物档案**：从 AI 回复里提取状态，自动更新五大区域（基础档案 / 容貌特征 / 身体数据 / 隐私档案 / 经验档案）
- **电波系统**：手动或由 AI 在剧情中发射，写入「聊天绑定世界书」，让 AI 真正记得自己发过什么
- **地图编辑**：新建地点、拖动摆位、改名字与介绍；底层 XY 坐标会同步进世界书，让 AI 理解方位关系
- **隐藏角色**：状态冻结、地图隐藏，可随时恢复
- **设置页**：电波合理化改写 / 同步者抵抗 / 档案仅收录女性，开关实时写进世界书
- **电波同名去重**：AI 换措辞复述同一条电波时会自动合并，不会出现重复条目

## 依赖

**必需**

- SillyTavern **1.12.0** 以上（已在 1.16.0 上逐条核对源码）
- 酒馆核心的 STscript 世界信息命令：`/getchatbook` `/createentry` `/setentryfield`
  （写在 `public/scripts/world-info.js`，属于核心功能，不是扩展）

**不需要**

- 任何第三方扩展
- 与 ST-Prompt-Template、JS-Slash-Runner 互不干扰

## 安装

### 方式一：从仓库 URL 安装（推荐，手机也能用）

把本仓库地址粘进酒馆的扩展安装器：

```
https://github.com/<你的用户名>/<仓库名>
```

- **桌面版酒馆**：扩展面板 → 安装扩展 → 粘贴上面的 URL
- **SillyDroid（安卓）**：右上角设置 → 扩展/插件管理 → 安装扩展 → 粘贴 URL

> SillyDroid 的扩展管理器基于 git clone，并会校验 GitHub 可达性。
> 如果 GitHub 连不上，安装会失败 —— 这种情况请用方式二。

### 方式二：手动复制

```
<SillyTavern>/data/<用户名>/extensions/radiowave/
    ├─ manifest.json
    ├─ index.js
    └─ style.css
```

放好后重启酒馆或按 `Ctrl + F5` 硬刷新。

### 验证

按 F12 打开控制台，应该看到：

```
[无意识电波] 扩展已加载 v0.13.1
[无意识电波] 诊断快照： {…}
```

## 数据存放

| 数据 | 位置 |
|---|---|
| 人物档案 / 电波 / 设置 / 自建地点 | `chatMetadata.radiowave_app`（每个存档独立） |
| 预设初始档案 | 角色卡 `extensions.radiowave.seed`（不进提示词，零 token） |
| 已发射的电波 | 聊天绑定世界书，条目名 `电波·<名>` |
| 世界运行模式 | 聊天绑定世界书，条目名 `电波运作模式` |
| 地图方位 | 聊天绑定世界书，条目名 `方位图·<地点>`（关键词触发） |

不写入角色卡本体，可以放心分享。

## 头像（可选）

三级回退，没图也能用：

1. `characters/无意识电波/rw/<角色名>.png`
2. `characters/无意识电波/rw/pool/0.png ~ 11.png`（按角色名哈希挑选）
3. 按角色名哈希程序化生成 SVG

## 目录结构

按 SillyTavern 扩展规范，`manifest.json` 必须在**仓库根目录**：

```
.
├─ manifest.json     ← 扩展声明（安装器 clone 后先校验它）
├─ index.js          ← 扩展主体
├─ style.css         ← 样式
└─ README.md
```

> 不要套一层 `extension/` 子目录，否则安装器找不到 manifest 会失败。

## 许可

扩展为本项目定制生成，可自由修改与分享。
依赖 [SillyTavern](https://github.com/SillyTavern/SillyTavern) 的客户端扩展 API 与 STscript 世界信息命令。
