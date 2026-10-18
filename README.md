# LX Music → SPlayer-Next 歌单导入插件

[简体中文](#简体中文) | [English](#english)

---

## 简体中文

把 **[LX Music（洛雪音乐）](https://github.com/lyswhut/lx-music-desktop)** 的歌单导入到 **[SPlayer-Next](https://github.com/SPlayer-Dev/SPlayer-Next)** 播放器。

支持两种导入目标：
- **播放队列** — 导入到 SPlayer-Next 当前播放队列
- **网易云歌单** — 在网易云音乐创建新歌单并添加歌曲（v2.0 新增）

### 功能特性

- 自动解析 LX Music 的多种歌单格式（`.lxmc` 备份、`playlist.json`、单歌单导出）
- 智能歌曲匹配：标题相似度 + 歌手相似度 + 时长 proximity 算法
- 网易云歌单模式：网易云源歌曲直接用原 ID 秒添加，其他源搜索匹配后添加
- 配套 `.lxmc` 解压工具（Python，无第三方依赖）
- 支持 8 种歌单数据结构自动识别

### 快速开始

1. **安装插件**：SPlayer-Next → 设置 → 插件管理 → 本地导入 `splayer-lx-playlist-importer.js`
2. **解压歌单**：双击 `解压lxmc.bat` 选择 `.lxmc` 文件，自动复制 JSON 到剪贴板
3. **粘贴数据**：插件设置里，把 JSON 粘贴到「LX Music 歌单 JSON」框
4. **选择目标**：「导入目标」选「播放队列」或「网易云歌单」
5. **触发导入**：右键任意歌曲 → 「导入 LX Music 歌单」

详细说明见 [使用说明.md](使用说明.md)。

### 文件说明

| 文件 | 说明 |
|------|------|
| `splayer-lx-playlist-importer.js` | SPlayer-Next 插件主文件 |
| `lxmc_decoder.py` | `.lxmc` 文件解压工具（Python 标准库） |
| `解压lxmc.bat` | Windows 双击运行解压工具的批处理 |
| `使用说明.md` | 详细使用文档 |

### 系统要求

- SPlayer-Next v1.2.0-nightly 及以上（API Level 4+）
- 网易云歌单模式需在 SPlayer-Next 中登录网易云账号
- 解压工具需要 Python 3.8+（仅需标准库）

### 技术细节

- 插件 ID: `you.lx-playlist-importer`
- 版本: 2.0.0
- API Level: 4
- 权限: `network` + `control` + `ui` + `api`

### 许可证

AGPL-3.0（与 SPlayer-Next 保持许可证兼容）

---

## English

Import playlists from **[LX Music](https://github.com/lyswhut/lx-music-desktop)** into **[SPlayer-Next](https://github.com/SPlayer-Dev/SPlayer-Next)**.

Supports two import targets:
- **Play Queue** — Import into SPlayer-Next's current play queue
- **Netease Playlist** — Create a new playlist on NetEase Cloud Music and add songs (v2.0)

### Features

- Auto-detects 8 LX Music playlist formats (`.lxmc` backup, `playlist.json`, single playlist export)
- Smart song matching: title similarity + artist similarity + duration proximity
- Netease mode: songs from NetEase source use original IDs directly (no search needed)
- Bundled `.lxmc` decoder (Python stdlib only, no dependencies)

### Quick Start

1. **Install plugin**: SPlayer-Next → Settings → Plugin Manager → Import `splayer-lx-playlist-importer.js`
2. **Decode playlist**: Double-click `解压lxmc.bat` to select `.lxmc` file (JSON copied to clipboard)
3. **Paste data**: Paste JSON into the plugin's "LX Music 歌单 JSON" setting
4. **Choose target**: Select "Play Queue" or "Netease Playlist"
5. **Trigger import**: Right-click any song → "Import LX Music Playlist"

### License

AGPL-3.0 (license-compatible with SPlayer-Next)
