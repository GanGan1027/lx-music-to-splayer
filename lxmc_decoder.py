# -*- coding: utf-8 -*-
"""
LX Music .lxmc 文件解压器
=========================
将 LX Music 导出的 .lxmc 备份文件解压为 JSON，
并复制到剪贴板，供 SPlayer-Next 的「LX Music 歌单导入」插件使用。

.lxmc 格式：GZIP 压缩的 JSON 文件（不是加密）。
解压后常见结构：
  - 单个歌单导出：{"type": "playListPart_v2", "data": {name,id,list:[...]}}
  - 多歌单导出：  {"type": "playList_v2", "data": [歌单数组]}
  - 全量备份：    {"type": "allData_v2", "playList": [...], "setting": {...}}

用法：
  1. 双击「解压lxmc.bat」选择文件
  2. 或把 .lxmc 文件拖到「解压lxmc.bat」上
  3. 或命令行：python lxmc_decoder.py <文件路径>
"""

import sys
import os
import gzip
import json

# Windows cmd 默认 GBK，强制 stdout/stderr 用 UTF-8，避免中文打印报 UnicodeEncodeError
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass


def decode_lxmc(file_path):
    """解压 .lxmc 文件，返回解析后的 dict"""
    if not os.path.isfile(file_path):
        raise FileNotFoundError(f"文件不存在：{file_path}")

    with open(file_path, "rb") as f:
        raw = f.read()

    # .lxmc 是 gzip 压缩的 JSON
    try:
        decompressed = gzip.decompress(raw)
    except Exception as e:
        # 也许它本来就是 JSON（用户改过扩展名）
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            raise RuntimeError(f"解压失败，文件可能不是有效的 .lxmc：{e}")

    text = decompressed.decode("utf-8")
    return json.loads(text)


def extract_playlists(data):
    """从解压后的数据里提取歌单列表，返回统一格式 [{id,name,list:[...]}, ...]"""
    # 格式 0: {type:"playListPart_v2", data:{单个歌单对象}}
    # LX Music 单个歌单导出的 .lxmc 就是这种结构（data 是 dict 不是数组）
    if isinstance(data, dict) and data.get("type") == "playListPart_v2":
        part = data.get("data")
        if isinstance(part, dict) and isinstance(part.get("list"), list):
            return [part]
        if isinstance(part, list):
            return part  # 容错：偶尔 data 是数组

    # 格式 1: {type:"playList_v2", data:[歌单数组]}
    if isinstance(data, dict) and data.get("type") == "playList_v2":
        lists = data.get("data", [])
        if isinstance(lists, list):
            return lists

    # 格式 2: {type:"allData_v2", playList:[...], setting:{...}}
    if isinstance(data, dict) and data.get("type") == "allData_v2":
        return data.get("playList", [])

    # 格式 3: 直接是歌单数组
    if isinstance(data, list):
        return data

    # 格式 4: 老版本 {type:"playList", data:[...]}
    if isinstance(data, dict) and data.get("type") == "playList":
        return data.get("data", [])

    # 格式 5: MyAllList 结构 {defaultList, loveList, userList}
    if isinstance(data, dict) and (
        "defaultList" in data or "loveList" in data or "userList" in data
    ):
        result = []
        if data.get("defaultList"):
            result.append(data["defaultList"])
        if data.get("loveList"):
            result.append(data["loveList"])
        if data.get("userList"):
            result.extend(data["userList"])
        return result

    raise RuntimeError(f"无法识别的数据结构，type={data.get('type') if isinstance(data, dict) else type(data)}")


def _pick_file_dialog():
    """用 Windows 原生 API 弹文件选择框，不依赖 tkinter/PowerShell"""
    if sys.platform != "win32":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        # GetOpenFileNameW 结构体
        class OPENFILENAMEW(ctypes.Structure):
            _fields_ = [
                ("lStructSize", wintypes.DWORD),
                ("hwndOwner", wintypes.HWND),
                ("hInstance", wintypes.HINSTANCE),
                ("lpstrFilter", wintypes.LPCWSTR),
                ("lpstrCustomFilter", wintypes.LPWSTR),
                ("nMaxCustFilter", wintypes.DWORD),
                ("nFilterIndex", wintypes.DWORD),
                ("lpstrFile", wintypes.LPWSTR),
                ("nMaxFile", wintypes.DWORD),
                ("lpstrFileTitle", wintypes.LPWSTR),
                ("nMaxFileTitle", wintypes.DWORD),
                ("lpstrInitialDir", wintypes.LPCWSTR),
                ("lpstrTitle", wintypes.LPCWSTR),
                ("Flags", wintypes.DWORD),
                ("nFileOffset", wintypes.WORD),
                ("nFileExtension", wintypes.WORD),
                ("lpstrDefExt", wintypes.LPCWSTR),
                ("lCustData", wintypes.LPARAM),
                ("lpfnHook", ctypes.c_void_p),
                ("lpTemplateName", wintypes.LPCWSTR),
                ("pvReserved", ctypes.c_void_p),
                ("dwReserved", wintypes.DWORD),
                ("FlagsEx", wintypes.DWORD),
            ]

        OFN_EXPLORER = 0x00080000
        OFN_FILEMUSTEXIST = 0x00001000
        OFN_HIDEREADONLY = 0x00000004
        OFN_NOCHANGEDIR = 0x00000008

        ofn = OPENFILENAMEW()
        ofn.lStructSize = ctypes.sizeof(ofn)
        ofn.lpstrFilter = "LX Music 备份 (*.lxmc)\0*.lxmc\0JSON 文件 (*.json)\0*.json\0所有文件 (*.*)\0*.*\0\0"
        ofn.lpstrTitle = "选择 LX Music 导出的 .lxmc 文件"
        ofn.Flags = OFN_EXPLORER | OFN_FILEMUSTEXIST | OFN_HIDEREADONLY | OFN_NOCHANGEDIR
        buf = ctypes.create_unicode_buffer(260)
        ofn.lpstrFile = ctypes.cast(buf, wintypes.LPWSTR)
        ofn.nMaxFile = 260

        comdlg32 = ctypes.windll.comdlg32
        if comdlg32.GetOpenFileNameW(ctypes.byref(ofn)):
            return buf.value
    except Exception as e:
        print(f"文件对话框调用失败：{e}")
    return None


def main():
    if len(sys.argv) < 2:
        # 没传参数，先尝试弹文件选择框
        print("=" * 50)
        print("  LX Music .lxmc 解压器")
        print("=" * 50)
        print("\n请在弹出的对话框中选择 .lxmc 文件...\n")
        file_path = _pick_file_dialog()
        if not file_path:
            # 对话框失败或用户取消，降级为手动输入
            print("未弹出对话框或未选择文件。")
            print("你可以：")
            print("  1) 把 .lxmc 文件直接拖到「解压lxmc.bat」图标上")
            print("  2) 或在下面手动输入 .lxmc 文件的完整路径")
            print()
            try:
                file_path = input("文件路径> ").strip().strip('"')
            except (EOFError, KeyboardInterrupt):
                return 1
            if not file_path:
                print("未输入路径，退出。")
                _pause("按回车键退出...")
                return 1
    else:
        file_path = sys.argv[1]

    print(f"\n正在处理：{file_path}")

    try:
        data = decode_lxmc(file_path)
    except Exception as e:
        print(f"解压失败：{e}")
        _pause("按回车键退出...")
        return 1

    print(f"解压成功，type = {data.get('type') if isinstance(data, dict) else 'N/A'}")

    playlists = extract_playlists(data)
    total_songs = sum(len(p.get("list", [])) for p in playlists)
    print(f"找到 {len(playlists)} 个歌单，共 {total_songs} 首歌：")
    for p in playlists:
        print(f"  - {p.get('name', p.get('id', '未命名'))}（{len(p.get('list', []))} 首）")

    # 生成要给插件的 JSON（保留原始结构，插件已支持多种格式）
    output_json = json.dumps(data, ensure_ascii=False)

    # 保存 .json 文件到原目录
    base, _ = os.path.splitext(file_path)
    json_path = base + ".json"
    with open(json_path, "w", encoding="utf-8") as f:
        f.write(output_json)
    print(f"\n已保存 JSON 文件：{json_path}")

    # 复制到剪贴板（用 PowerShell，跨 Windows 版本最稳）
    import subprocess
    try:
        ps_script = (
            "$ErrorActionPreference='Stop';"
            "Set-Clipboard -Value $input;"
        )
        subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps_script],
            input=output_json,
            text=True,
            encoding="utf-8",
            check=True,
        )
        print("已复制 JSON 到剪贴板 ✓")
    except Exception as e:
        print(f"复制到剪贴板失败：{e}")
        print(f"请手动打开 {json_path} 复制内容")

    print("\n" + "=" * 50)
    print("下一步：打开 SPlayer-Next → 设置 → 插件管理")
    print("→ 找到「LX Music 歌单导入」→ 设置")
    print("→ 把剪贴板内容粘贴到「LX Music 歌单 JSON」框")
    print("→ 保存，然后右键任意歌曲选「导入 LX Music 歌单到队列」")
    print("=" * 50)

    _pause("\n按回车键退出...")
    return 0


def _pause(msg="\n按回车键退出..."):
    """等待用户回车，避免窗口一闪而过；非交互环境直接返回"""
    try:
        input(msg)
    except (EOFError, KeyboardInterrupt):
        print()


if __name__ == "__main__":
    sys.exit(main())
