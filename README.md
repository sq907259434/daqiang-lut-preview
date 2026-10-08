# 大强LUT预览

**中文** | [English](README.en.md)

一个 Photoshop 面板插件（UXP）：把**当前照片**套上文件夹里的**每一个 3D LUT**，以缩略图网格一次性预览；**双击缩略图**，直接新建一个已载入该 LUT 的“颜色查找”调整图层。

给修图师用的：不用再一个个点开“颜色查找”里的 LUT 去翻着看效果。

## 功能

- 当前照片 × 全部 LUT 的缩略图墙，窗口拉大显示更多，右侧滚动条
- **双击缩略图** → 新建“颜色查找”**调整图层**（不是像素图层）
  - 图层名 = 缩略图名；不透明度跟随“强度”滑块
  - 属性面板里是真正载入的 3D LUT，可以把图层拖到其他照片，方便整组照片统一色调
- 支持 `.cube` 和 `.3dl`（含 VSCO 等常见 LUT 包）
- 自动查找 Photoshop 自带的 `Presets/3DLUTs` 文件夹；也可以手动选择任意文件夹
- 搜索、强度、缩略图大小；缩略图随大小自动调整清晰度
- 切换到另一张照片时自动刷新预览（可关），也可手动刷新；刷新后保持滚动位置

## 安装

1. 到 [Releases](../../releases) 下载 `DaqiangLUTPreview-vX.Y.Z.ccx`
2. 双击 `.ccx` 安装（会调用 Photoshop 的插件安装器）
3. 重启 Photoshop，菜单 **增效工具 → 大强LUT预览** 打开面板

也可以用 Adobe 的 **UXP Developer Tool** 加载本仓库的 `plugin/` 文件夹（开发调试用）。

> 需要 Photoshop 23.3（2022）以上；作者在 Windows + Photoshop 2026（27.10）上使用测试。macOS 与其他版本未充分测试。

## 使用

| 操作 | 说明 |
| --- | --- |
| 打开面板 | 先在 Photoshop 里打开一张照片 |
| 双击缩略图 | 新建已载入该 LUT 的“颜色查找”调整图层 |
| 搜索框 | 按名称筛选 LUT |
| 文件夹图标 | 选择 LUT 文件夹；按住 **Alt** 点击恢复为 PS 自带文件夹 |
| 换图自动刷新 | 开：切换到另一张照片时自动更新预览 |
| ↻ 刷新 | 按**当前画面**重新生成预览 |
| 强度 | 缩略图预览强度，同时作为新建图层的不透明度 |
| 大小 | 缩略图大小（越大越清晰，数量越少） |

**提示**：预览读取的是照片当前的合成画面。如果已经加了颜色查找图层再刷新，预览会在已调色的画面上再叠一层 LUT。想看“原片 + LUT”，先隐藏已有的调色图层再点刷新。

## 它是怎么做到“载入 LUT”的

Photoshop 的“颜色查找”图层里除了 LUT 文件内容，还需要一份 ICC DeviceLink 配置文件才会真正渲染。
这在 UXP 里没有官方文档，所以插件的做法是：

1. 读取 LUT 文件并解析（`lut.js`），重采样为 33³ 网格
2. 生成 ICC v4 DeviceLink 配置文件（`buildIccDeviceLink`）
3. 用 `batchPlay` 新建 `colorLookup` 调整图层，写入完整路径、LUT 原始字节与配置文件
4. 对比添加前后的画面确认确实生效，没生效的空图层会自动删除

## 已知限制

- 预览是插件自己用 JS 计算的近似结果（三线性插值，sRGB），与 Photoshop 最终渲染可能有细微差别
- 非常大的 LUT 文件夹首次渲染需要一点时间
- 颜色查找的 batchPlay 描述符来自对 Photoshop 自身行为的观察，Photoshop 以后更新可能需要调整

## 目录结构

```
plugin/      插件源码（manifest.json、index.html、index.js、lut.js、styles.css）
dist/        打包好的 .ccx
```

## 自己打包

`.ccx` 本质是一个 zip，文件放在压缩包根目录：

```bash
cd plugin
zip -r ../dist/DaqiangLUTPreview.ccx manifest.json index.html index.js lut.js styles.css icons
```

## 许可

[MIT](LICENSE)
