const { app, core, action, imaging } = require("photoshop");
const { batchPlay } = action;
const { storage } = require("uxp");
const { parseLut, applyLUT, buildIccDeviceLink, toBase64 } = require("./lut.js");

const fs = storage.localFileSystem;
const SRGB = "sRGB IEC61966-2.1";
const LUT_FILE = /\.(cube|3dl)$/i;
const GAP = 6; // 缩略图之间的间距（左右各 3px 外边距）

let PLATFORM = "win32";
try { PLATFORM = require("os").platform(); } catch (e) { /* 取不到就按 Windows 处理 */ }

const $ = (id) => document.getElementById(id);
const grid = $("grid");
const scrollBox = $("scroll");
const statusEl = $("status");

let lutFiles = [];           // [{ name, ext, fileName, entry, inPs }]
const lutCache = new Map();  // fileName -> 解析后的 LUT（只用于缩略图预览）
let thumb = null;            // 当前照片缩略图 { data, width, height }
let renderToken = 0;         // 用于中途取消渲染
let busy = false;            // 正在往文档里写东西
let suppressUntil = 0;       // 自己改动文档后的一小段时间内不自动刷新预览
let selectedItem = null;
let lastClick = { item: null, t: 0 };
let lastCreateAt = 0;

let minTile = 130;           // 每个缩略图的最小宽度：窗口越宽，一行放得越多，铺满整个区域
let tileW = 120;
let tileCols = 0;
let lastThumbSize = 0;
let tileEls = [];            // 当前所有缩略图元素，按顺序

const setStatus = (t) => (statusEl.textContent = t);
const tick = () => new Promise((r) => setTimeout(r, 0));
const intensity = () => Number($("intensity").value) / 100;

// ---------- 版面：按面板宽度算每行放几张，铺满整个滚动区域 ----------

function appendTile(tile) {
  tileEls.push(tile);
  placeTile(tile);
}

function placeTile(tile) {
  if (tile._hdr) { grid.appendChild(tile); return; }
  let line = grid.lastChild;
  if (!line || !line.classList.contains("line") || line.childNodes.length >= Math.max(1, tileCols)) {
    line = document.createElement("div");
    line.className = "line";
    grid.appendChild(line);
  }
  line.appendChild(tile);
}

function reflow() {
  grid.innerHTML = "";
  for (const t of tileEls) {
    if (!t._hdr) t.style.width = tileW + "px";
    placeTile(t);
  }
}

function layout() {
  const winH = window.innerHeight || document.documentElement.clientHeight || 600;
  const rect = scrollBox.getBoundingClientRect ? scrollBox.getBoundingClientRect() : null;
  const top = rect ? rect.top : scrollBox.offsetTop || 0;
  scrollBox.style.height = Math.max(120, Math.floor(winH - top - 32)) + "px";

  const avail = Math.max(100, (scrollBox.clientWidth || 300) - 20); // 留出滚动条宽度
  const cols = Math.max(1, Math.floor(avail / minTile));
  const w = Math.floor(avail / cols) - GAP;
  if (w !== tileW || cols !== tileCols) {
    const colsChanged = cols !== tileCols;
    tileW = w;
    tileCols = cols;
    tileEls.forEach((t) => { if (!t._hdr) t.style.width = w + "px"; });
    if (colsChanged) reflow();
  }
}

// 缩略图分辨率跟着格子宽度走：3 倍于格子宽度，最低 480 像素，最高 1400
function thumbSize() {
  return Math.min(1400, Math.max(Math.round(tileW * 3), 480));
}

let resizeTimer = null;
function onResize() {
  layout();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!lastThumbSize || Math.abs(thumbSize() - lastThumbSize) / lastThumbSize > 0.3) renderAll();
  }, 350);
}

// ---------- Photoshop 版本与自带 3DLUTs 文件夹 ----------

function psVersion() {
  let v = "";
  try { v = String(app.version || ""); } catch (e) { /* ignore */ }
  if (!v) { try { v = String(require("uxp").host.version || ""); } catch (e) { /* ignore */ } }
  const major = parseInt(v, 10);
  return { text: v, major: isFinite(major) ? major : null };
}

async function tryFolder(path) {
  const base = PLATFORM === "darwin" ? "file://" + path : "file:///" + path;
  for (const url of [base, encodeURI(base)]) {
    try {
      const e = await fs.getEntryWithUrl(url);
      if (e && e.isFolder) return e;
    } catch (err) { /* 路径不存在或没有权限，换下一种写法 */ }
  }
  return null;
}

async function detectPsLutFolder() {
  const { major } = psVersion();
  // Photoshop 2026 的内部主版本号是 27，所以 年份 = 1999 + 主版本号
  const years = major ? [1999 + major, 1998 + major, 2000 + major] : [2026, 2025, 2024];
  const roots = PLATFORM === "darwin"
    ? ["/Applications"]
    : ["C:/Program Files/Adobe", "D:/Program Files/Adobe", "E:/Program Files/Adobe", "F:/Program Files/Adobe"];

  for (const root of roots) {
    for (const y of years) {
      const f = await tryFolder(`${root}/Adobe Photoshop ${y}/Presets/3DLUTs`);
      if (f) return f;
    }
  }
  for (const root of roots) {
    const dir = await tryFolder(root);
    if (!dir) continue;
    try {
      const names = (await dir.getEntries())
        .filter((e) => e.isFolder && /^Adobe Photoshop/i.test(e.name))
        .map((e) => e.name)
        .sort()
        .reverse();
      for (const n of names) {
        const f = await tryFolder(`${root}/${n}/Presets/3DLUTs`);
        if (f) return f;
      }
    } catch (err) { /* 忽略 */ }
  }
  return null;
}

async function autoFolder(userClicked) {
  const folder = await detectPsLutFolder();
  if (!folder) {
    if (userClicked) setStatus("没有在默认位置找到 Photoshop 的 3DLUTs 文件夹，请点搜索框右边的文件夹图标选择手动选择");
    return false;
  }
  if (userClicked) {
    try { localStorage.removeItem("lutFolderToken"); } catch (e) { /* ignore */ }
  }
  await useFolder(folder, "Photoshop 自带");
  return true;
}

// ---------- 文件夹与 LUT 列表 ----------

async function scanFolder(folder, out, depth = 0) {
  const entries = await folder.getEntries();
  for (const e of entries) {
    if (e.isFile && LUT_FILE.test(e.name)) {
      out.push({
        name: e.name.replace(LUT_FILE, ""),
        ext: e.name.split(".").pop().toLowerCase(),
        fileName: e.name,
        entry: e,
        inPs: /presets[\\/]+3dluts/i.test(e.nativePath || ""),
      });
    } else if (e.isFolder && depth < 3) {
      await scanFolder(e, out, depth + 1);
    }
  }
}

async function useFolder(folder, label) {
  const list = [];
  await scanFolder(folder, list);
  list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  lutFiles = list;
  lutCache.clear();
  const ver = psVersion().text;
  setStatus(`${label}：共 ${list.length} 个 LUT · 双击缩略图添加调整图层`);
}

async function pickFolder() {
  const folder = await fs.getFolder();
  if (!folder) return;
  try {
    const token = await fs.createPersistentToken(folder);
    localStorage.setItem("lutFolderToken", token);
  } catch (e) { console.log(e); }
  await useFolder(folder, "已选文件夹");
  await renderAll();
}

async function restoreFolder() {
  try {
    const token = localStorage.getItem("lutFolderToken");
    if (!token) return false;
    const folder = await fs.getEntryForPersistentToken(token);
    await useFolder(folder, "上次选择的文件夹");
    return true;
  } catch (e) {
    console.log("恢复文件夹失败", e);
    return false;
  }
}

async function loadLut(item) {
  if (lutCache.has(item.fileName)) return lutCache.get(item.fileName);
  if (item.error) throw new Error(item.error);
  try {
    const text = await item.entry.read();
    const lut = parseLut(text, item.ext);
    lutCache.set(item.fileName, lut);
    return lut;
  } catch (e) {
    item.error = e.message || String(e);
    throw e;
  }
}

// ---------- 像素读取 / 显示 ----------

function to3(data, comps) {
  if (comps === 3) return data;
  const n = data.length / comps;
  const out = new Uint8Array(n * 3);
  for (let i = 0, j = 0, k = 0; i < n; i++, j += comps, k += 3) {
    out[k] = data[j];
    out[k + 1] = data[j + 1];
    out[k + 2] = data[j + 2];
  }
  return out;
}

async function readPixels(doc, targetSize) {
  let result = null;
  await core.executeAsModal(
    async () => {
      const opts = {
        documentID: doc.id,
        colorSpace: "RGB",
        colorProfile: SRGB,
        componentSize: 8,
      };
      if (targetSize) opts.targetSize = targetSize;
      const r = await imaging.getPixels(opts);
      const img = r.imageData;
      const raw = await img.getData({ chunky: true });
      result = {
        data: to3(raw, img.components),
        width: img.width,
        height: img.height,
      };
      img.dispose();
    },
    { commandName: "读取图像" }
  );
  return result;
}

async function toDataUrl(data, w, h) {
  const img = await imaging.createImageDataFromBuffer(data, {
    width: w,
    height: h,
    components: 3,
    colorSpace: "RGB",
    colorProfile: SRGB,
    chunky: true,
  });
  const b64 = await imaging.encodeImageData({ imageData: img, base64: true });
  img.dispose();
  return "data:image/jpeg;base64," + b64;
}

// ---------- 预览网格 ----------

function setSelected(tile) {
  grid.querySelectorAll(".tile.selected").forEach((t) => t.classList.remove("selected"));
  if (tile) tile.classList.add("selected");
}

function triggerCreate(item) {
  const now = Date.now();
  if (now - lastCreateAt < 1200) return; // 防止 click 判定和 dblclick 事件重复触发
  lastCreateAt = now;
  createColorLookup(item);
}

function addTile(name, url, item, errMsg) {
  const tile = document.createElement("div");
  tile.className = "tile" + (errMsg ? " bad" : "");
  tile.style.width = tileW + "px";
  const img = document.createElement("img");
  img.src = url;
  const label = document.createElement("div");
  label.className = "name";
  label.textContent = errMsg ? name + "（无预览）" : name;
  tile.appendChild(img);
  tile.appendChild(label);
  if (item && item === selectedItem) tile.classList.add("selected");

  const pick = () => {
    setSelected(tile);
    selectedItem = item;
  };

  tile.addEventListener("click", () => {
    if (!item) return; // “原图”没有对应的 LUT
    const now = Date.now();
    pick();
    if (lastClick.item === item && now - lastClick.t < 650) {
      lastClick = { item: null, t: 0 };
      triggerCreate(item); // 双击：新建“颜色查找”调整图层
    } else {
      lastClick = { item, t: now };
      setStatus(errMsg ? `${item.name}：无法生成预览（${errMsg}），仍可双击添加图层` : `已选中 ${item.name}，双击添加颜色查找图层`);
    }
  });
  tile.addEventListener("dblclick", () => {
    if (!item) return;
    pick();
    triggerCreate(item);
  });
  appendTile(tile);
}

// ---------- 常用 LUT：按双击次数统计，排在最前面 ----------
const FAV_COUNT = 9; // 3 × 3 九宫格
function loadUsage() {
  try { return JSON.parse(localStorage.getItem("lutUsage") || "{}") || {}; } catch (e) { return {}; }
}
function bumpUsage(fileName) {
  try {
    const u = loadUsage();
    u[fileName] = (u[fileName] || 0) + 1;
    localStorage.setItem("lutUsage", JSON.stringify(u));
  } catch (e) { /* 存不了就算了 */ }
}
let favOpen = true;
try { favOpen = localStorage.getItem("lutFavOpen") !== "0"; } catch (e) { /* ignore */ }

function addHeader(text, onClick, tip) {
  const h = document.createElement("div");
  h._hdr = true;
  h.className = "hdr" + (onClick ? " click" : "");
  h.textContent = text;
  if (tip) h.title = tip;
  if (onClick) h.addEventListener("click", onClick);
  appendTile(h);
}

// 本次渲染的缩略图结果缓存：展开/折叠“常用”时不用重新计算
let cache = { orig: null, map: new Map(), complete: false };

function makeOrder(list, kw) {
  const usage = loadUsage();
  const top = kw ? [] : list
    .filter((f) => usage[f.fileName] > 0)
    .sort((a, b) => usage[b.fileName] - usage[a.fileName] || a.name.localeCompare(b.name))
    .slice(0, FAV_COUNT);
  const order = [];
  if (top.length) {
    // “常用”标题 → 原图（紧挨着常用 LUT，方便对比）→ 常用 LUT → “全部”
    order.push({ hdr: `${favOpen ? "▾" : "▸"} 常用（${top.length}）`, fav: true });
    order.push({ orig: true });
    if (favOpen) {
      top.forEach((f) => order.push({ item: f }));
      order.push({ hdr: "全部" });
      list.filter((f) => !top.includes(f)).forEach((f) => order.push({ item: f }));
      return order;
    }
  } else {
    order.push({ orig: true });
  }
  list.forEach((f) => order.push({ item: f }));
  return order;
}

function toggleFav(e) {
  if (e && e.altKey) {
    try { localStorage.removeItem("lutUsage"); } catch (err) { /* ignore */ }
    setStatus("已清空使用记录");
    renderAll();
    return;
  }
  favOpen = !favOpen;
  try { localStorage.setItem("lutFavOpen", favOpen ? "1" : "0"); } catch (e) { /* ignore */ }
  if (!cache.complete) { renderAll(); return; }
  const top0 = scrollBox.scrollTop;
  const kw = $("filter").value.trim().toLowerCase();
  const list = lutFiles.filter((f) => !kw || f.name.toLowerCase().includes(kw));
  grid.innerHTML = "";
  tileEls = [];
  for (const o of makeOrder(list, kw)) {
    if (o.orig) addTile("原图", cache.orig, null);
    else if (o.hdr) addHeader(o.hdr, o.fav ? toggleFav : null, o.fav ? "点击折叠/展开；按住 Alt 点击清空使用记录" : null);
    else { const c = cache.map.get(o.item.fileName); if (c) addTile(o.item.name, c.url, o.item, c.err); }
  }
  scrollBox.scrollTop = top0;
}

let resetScroll = false; // 搜索词变化时回到顶部，其余刷新保持当前滚动位置
async function renderAll() {
  const token = ++renderToken;
  const keepTop = resetScroll ? 0 : scrollBox.scrollTop;
  resetScroll = false;
  const doc = app.activeDocument;
  lastDocId = doc ? doc.id : null;
  if (!doc) {
    grid.innerHTML = "";
    tileEls = [];
    setStatus("请先打开一张照片");
    return;
  }
  if (!lutFiles.length) {
    setStatus("没有找到 LUT，请点搜索框右边的文件夹图标选择");
    return;
  }

  try {
    setStatus("读取图像…");
    layout();
    const maxSide = thumbSize();
    lastThumbSize = maxSide;
    const s = Math.min(1, maxSide / Math.max(doc.width, doc.height));
    thumb = await readPixels(doc, {
      width: Math.max(1, Math.round(doc.width * s)),
      height: Math.max(1, Math.round(doc.height * s)),
    });
    if (token !== renderToken) return;

    const kw = $("filter").value.trim().toLowerCase();
    const list = lutFiles.filter((f) => !kw || f.name.toLowerCase().includes(kw));

    grid.style.minHeight = (keepTop + scrollBox.clientHeight) + "px"; // 重建期间撑住高度，滚动位置才不会被重置
    grid.innerHTML = "";
    tileEls = [];
    scrollBox.scrollTop = keepTop;
    const origUrl = await toDataUrl(thumb.data, thumb.width, thumb.height);
    cache = { orig: origUrl, map: new Map(), complete: false };

    const mix = intensity();
    let bad = 0;
    let firstBad = "";
    const order = makeOrder(list, kw);
    let done = 0;
    const total = list.length;
    for (const o of order) {
      if (token !== renderToken) return; // 被新的渲染取代
      if (o.orig) { addTile("原图", origUrl, null); continue; }
      if (o.hdr) { addHeader(o.hdr, o.fav ? toggleFav : null, o.fav ? "点击折叠/展开；按住 Alt 点击清空使用记录" : null); continue; }
      const f = o.item;
      try {
        const lut = await loadLut(f);
        const out = applyLUT(thumb.data, lut, mix);
        const url = await toDataUrl(out, thumb.width, thumb.height);
        cache.map.set(f.fileName, { url, err: null });
        addTile(f.name, url, f);
      } catch (e) {
        bad++;
        if (!firstBad) firstBad = `${f.fileName}：${e.message}`;
        cache.map.set(f.fileName, { url: origUrl, err: e.message });
        addTile(f.name, origUrl, f, e.message);
      }
      done++;
      setStatus(`渲染预览 ${done} / ${total}`);
      await tick();
      if (scrollBox.scrollTop !== keepTop && done % 8 === 0) scrollBox.scrollTop = keepTop;
    }
    cache.complete = true;
    grid.style.minHeight = "";
    scrollBox.scrollTop = keepTop;
    let msg = `共 ${list.length} 个 LUT，双击缩略图添加颜色查找图层`;
    if (bad) msg += `；${bad} 个无预览（${firstBad}）`;
    setStatus(msg);
  } catch (e) {
    console.log(e);
    setStatus("预览失败：" + e.message);
  }
}

// ---------- 新建“颜色查找”调整图层 ----------
// 颜色查找图层需要：完整路径、LUT 文件内容、以及由 LUT 生成的 ICC DeviceLink 配置文件。
// 创建后对比前后画面，确认 LUT 真的生效；没生效的空图层会被删除。

const TARGET_LAYER = { _ref: "layer", _enum: "ordinal", _value: "targetEnum" };
function firstError(result) {
  const r = Array.isArray(result) ? result[0] : result;
  if (r && r._obj === "error") return r.message || "Photoshop 返回了错误";
  return null;
}


// 用 batchPlay 直接写入 LUT 数据（二进制必须包成 { _rawData, _data }）
function rawBin(u8, how) {
  if (how === "base64") return { _rawData: "base64", _data: toBase64(u8) };
  const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  return { _rawData: "binary", _data: ab };
}

async function readLutBytes(item) {
  return new Uint8Array(await item.entry.read({ format: require("uxp").storage.formats.binary }));
}

function colorLookupProps(item, bytes, icc, how, kind) {
  const is3dl = item.ext === "3dl";
  const full = item.entry.nativePath || item.fileName;
  if (kind === "deviceLink") {
    return {
      _obj: "colorLookup",
      lookupType: { _enum: "colorLookupType", _value: "deviceLinkProfile" },
      name: full,
      profile: rawBin(icc, how),
    };
  }
  return {
    _obj: "colorLookup",
    lookupType: { _enum: "colorLookupType", _value: "3DLUT" },
    name: full,
    dither: true,
    profile: rawBin(icc, how),
    LUTFormat: { _enum: "LUTFormatType", _value: is3dl ? "LUTFormat3DL" : "LUTFormatCUBE" },
    dataOrder: { _enum: "colorLookupOrder", _value: "rgbOrder" },
    tableOrder: { _enum: "colorLookupOrder", _value: is3dl ? "rgbOrder" : "bgrOrder" },
    LUT3DFileData: rawBin(bytes, how),
    LUT3DFileName: full,
  };
}

// 取一张很小的合成图，用来比较添加图层前后画面有没有变化（需在模态范围内调用）
async function grabSmall(doc) {
  const s = Math.min(1, 48 / Math.max(doc.width, doc.height));
  const r = await imaging.getPixels({
    documentID: doc.id,
    colorSpace: "RGB",
    colorProfile: SRGB,
    componentSize: 8,
    targetSize: { width: Math.max(1, Math.round(doc.width * s)), height: Math.max(1, Math.round(doc.height * s)) },
  });
  const raw = await r.imageData.getData({ chunky: true });
  const out = new Uint8Array(to3(raw, r.imageData.components));
  r.imageData.dispose();
  return out;
}

function meanDiff(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

async function readbackLayer() {
  try {
    const r = await batchPlay([{ _obj: "get", _target: [TARGET_LAYER] }], {});
    const raw = r[0];
    const adj = raw && raw.adjustment && raw.adjustment[0];
    const data = adj && adj.LUT3DFileData;
    let dataLen = null;
    if (data && typeof data.byteLength === "number") dataLen = data.byteLength;
    else if (data && typeof data._rawData === "string") dataLen = data._rawData.length;
    else if (typeof data === "string") dataLen = data.length;
    return { raw, hasData: data != null && dataLen !== 0 };
  } catch (e) {
    return { raw: null, hasData: false };
  }
}

async function createColorLookup(item) {
  const doc = app.activeDocument;
  if (!doc) { setStatus("请先打开一张照片"); return; }
  if (busy) return;
  busy = true;
  suppressUntil = Date.now() + 10000;
  try {
    setStatus(`正在添加颜色查找图层：${item.name}…`);
    const opacity = Math.round(intensity() * 100);
    const tried = [];
    let used = null, verified = false, rb = null;

    const bytes = await readLutBytes(item);
    let lut = lutCache.get(item.fileName);
    if (!lut) lut = parseLut(await item.entry.read(), item.ext);
    const icc = buildIccDeviceLink(lut, item.name, 33);

    let before = null;
    await core.executeAsModal(async () => { before = await grabSmall(doc); }, { commandName: "读取画面" });

    const SPECS = [
      { kind: "3dlut", how: "binary" },
      { kind: "3dlut", how: "base64" },
      { kind: "deviceLink", how: "binary" },
      { kind: "deviceLink", how: "base64" },
    ];
    for (const spec of SPECS) {
      const label = `${spec.kind}/${spec.how}`;
      let diff = 0, err = null;
      try {
        await core.executeAsModal(async () => {
          const mk = await batchPlay([{
            _obj: "make",
            _target: [{ _ref: "adjustmentLayer" }],
            using: { _obj: "adjustmentLayer", name: item.name, type: { _class: "colorLookup" } },
          }], {});
          err = firstError(mk);
          if (!err) {
            const st = await batchPlay([{
              _obj: "set",
              _target: [{ _ref: "adjustmentLayer", _enum: "ordinal", _value: "targetEnum" }],
              to: colorLookupProps(item, bytes, icc, spec.how, spec.kind),
            }], {});
            err = firstError(st);
          }
          if (!err) {
            await new Promise((r) => setTimeout(r, 500));
            diff = meanDiff(before, await grabSmall(doc));
            rb = await readbackLayer();
          }
          if (err || diff < 0.4) {
            await batchPlay([{ _obj: "delete", _target: [TARGET_LAYER] }], {});
          }
        }, { commandName: `添加颜色查找：${item.name}` });
      } catch (e) {
        err = e.message || String(e);
      }
      if (err) { tried.push(`${label}: 出错（${err}）`); continue; }
      tried.push(`${label}: 画面变化 ${diff.toFixed(2)}`);
      if (diff >= 0.4) { used = spec; verified = true; break; }
    }

    if (used) {
      bumpUsage(item.fileName);
      await core.executeAsModal(async () => {
        await batchPlay([{ _obj: "set", _target: [TARGET_LAYER], to: { _obj: "layer", name: item.name } }], {});
        if (opacity < 100) {
          await batchPlay([{ _obj: "set", _target: [TARGET_LAYER], to: { _obj: "layer", opacity: { _unit: "percentUnit", _value: opacity } } }], {});
        }
      }, { commandName: "设置图层名称和不透明度" });
    }
    suppressUntil = Date.now() + 3000;

    if (!used) setStatus("没能让 LUT 生效（已撤销空图层）");
    else setStatus(`已添加“${item.name}”颜色查找图层，LUT 已生效`);
  } catch (e) {
    console.log(e);
    setStatus("添加失败：" + (e.message || e));
  } finally {
    busy = false;
  }
}

// ---------- 事件 ----------

$("btnFolder").addEventListener("click", async (e) => {
  if (e.altKey) { if (await autoFolder(true)) await renderAll(); }
  else await pickFolder();
});
let autoOn = true;
$("btnAutoRefresh").addEventListener("click", () => {
  autoOn = !autoOn;
  $("btnAutoRefresh").classList.toggle("on", autoOn);
});
$("btnRefresh").addEventListener("click", renderAll);

$("intensity").addEventListener("input", () => {
  $("intensityVal").textContent = $("intensity").value + "%";
});
$("intensity").addEventListener("change", renderAll);

$("tileSize").addEventListener("input", () => {
  minTile = Number($("tileSize").value);
  $("tileSizeVal").textContent = $("tileSize").value;
  onResize();
});

let filterTimer = null;
$("filter").addEventListener("input", () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => { resetScroll = true; renderAll(); }, 400);
});

// 换图自动刷新：只在切换到另一张照片时刷新（同一张照片里的改动、添加 LUT 图层都不触发）
let autoTimer = null;
let lastDocId = null;
function scheduleAuto() {
  if (!autoOn || busy) return;
  let id = null;
  try { id = app.activeDocument ? app.activeDocument.id : null; } catch (e) { id = null; }
  if (id === lastDocId) return;
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => { renderAll(); }, 500);
}
try {
  require("photoshop").action.addNotificationListener(
    [{ event: "select" }, { event: "open" }, { event: "close" }],
    scheduleAuto
  );
} catch (e) {
  console.log("通知监听不可用", e);
}

// 面板大小变化：既监听 resize，也轮询（有些版本的面板不触发 resize）
window.addEventListener("resize", onResize);
let lastSig = "";
setInterval(() => {
  const r = scrollBox.getBoundingClientRect ? scrollBox.getBoundingClientRect() : { top: 0 };
  const sig = (window.innerWidth || 0) + "x" + (window.innerHeight || 0) + "x" + (scrollBox.clientWidth || 0) + "x" + Math.round(r.top);
  if (sig !== lastSig) {
    lastSig = sig;
    onResize();
  }
}, 400);

// 启动：优先用上次手动选的文件夹，没有就自动找 Photoshop 自带的 3DLUTs 文件夹
layout();
(async () => {
  let ok = await restoreFolder();
  if (!ok) ok = await autoFolder(false);
  if (ok) await renderAll();
  else setStatus("没有在默认位置找到 Photoshop 的 3DLUTs 文件夹，请点搜索框右边的文件夹图标选择");
})();
