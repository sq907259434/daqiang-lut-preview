// LUT 解析（.cube / .3dl）+ 三线性插值应用
// 输入/输出均为 8 位 RGB（每像素 3 字节，无 alpha）
//
// 内部统一格式：
//   { size, data, size1, data1, dmin, dmax }
//   size/data   : 3D 表，边长 size，data 为 size^3*3 的浮点数，红色变化最快
//   size1/data1 : 可选的 1D 表（每通道 size1 个采样，data1 为 size1*3）
//   dmin/dmax   : 输入范围

const NUM = /^[-+]?(\d|\.\d)/;

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parseCube(text) {
  text = stripBom(text);
  let size3 = 0, size1 = 0;
  let dmin = [0, 0, 0], dmax = [1, 1, 1];
  let d3 = null, d1 = null, n3 = 0, n1 = 0;

  const lines = text.split(/\r\n|\n|\r/);
  for (const raw of lines) {
    let line = raw.trim();
    if (!line || line[0] === "#") continue;
    const hash = line.indexOf("#");
    if (hash > 0) line = line.slice(0, hash).trim();
    const p = line.split(/[\s,;]+/);

    if (!NUM.test(p[0])) {
      // 关键字行
      const key = p[0].toUpperCase();
      const nums = p.slice(1).map(Number).filter((v) => isFinite(v));
      if (key === "LUT_3D_SIZE") {
        size3 = parseInt(p[1], 10);
        if (!(size3 >= 2 && size3 <= 129)) throw new Error("LUT_3D_SIZE 不合理：" + p[1]);
        d3 = new Float32Array(size3 * size3 * size3 * 3);
      } else if (key === "LUT_1D_SIZE") {
        size1 = parseInt(p[1], 10);
        if (!(size1 >= 2 && size1 <= 65536)) throw new Error("LUT_1D_SIZE 不合理：" + p[1]);
        d1 = new Float32Array(size1 * 3);
      } else if (key === "DOMAIN_MIN" && nums.length) {
        dmin = nums.length >= 3 ? nums.slice(0, 3) : [nums[0], nums[0], nums[0]];
      } else if (key === "DOMAIN_MAX" && nums.length) {
        dmax = nums.length >= 3 ? nums.slice(0, 3) : [nums[0], nums[0], nums[0]];
      } else if ((key === "LUT_3D_INPUT_RANGE" || key === "LUT_1D_INPUT_RANGE") && nums.length >= 2) {
        dmin = [nums[0], nums[0], nums[0]];
        dmax = [nums[1], nums[1], nums[1]];
      }
      continue; // TITLE 等其它关键字忽略
    }

    if (p.length < 3) continue;
    const a = Number(p[0]), b = Number(p[1]), c = Number(p[2]);
    if (!isFinite(a) || !isFinite(b) || !isFinite(c)) continue;

    // 同时有 1D 和 3D 时，规范要求 1D 数据在前
    if (d1 && n1 < d1.length) { d1[n1++] = a; d1[n1++] = b; d1[n1++] = c; continue; }
    if (d3 && n3 < d3.length) { d3[n3++] = a; d3[n3++] = b; d3[n3++] = c; }
  }

  if (!d3 && !d1) throw new Error("没有找到 LUT_3D_SIZE 或 LUT_1D_SIZE");
  if (d1 && n1 !== d1.length) throw new Error(`1D 数据行数不对（需要 ${size1} 行，实际 ${n1 / 3} 行）`);
  if (d3 && n3 !== d3.length) throw new Error(`3D 数据行数不对（需要 ${size3 ** 3} 行，实际 ${n3 / 3} 行）`);
  for (let k = 0; k < 3; k++) {
    if (!(dmax[k] > dmin[k])) throw new Error("DOMAIN_MIN / DOMAIN_MAX 不合理");
  }
  return { size: size3, data: d3, size1, data1: d1, dmin, dmax };
}

// Autodesk / Lustre .3dl：整数网格，蓝色变化最快
function parse3dl(text) {
  text = stripBom(text);
  const rows = [];
  let maxV = 0;
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const line = raw.trim();
    if (!line || line[0] === "#") continue;
    if (!NUM.test(line)) continue; // 3DMESH / Mesh / gamma 等关键字
    const p = line.split(/[\s,;]+/).map(Number);
    if (p.some((v) => !isFinite(v))) continue;
    if (p.length !== 3) continue; // 多于 3 个数的是输入网格表头
    rows.push(p);
    for (const v of p) if (v > maxV) maxV = v;
  }
  const N = Math.round(Math.cbrt(rows.length));
  if (N < 2 || N * N * N !== rows.length) throw new Error(`3DL 数据行数 ${rows.length} 不是立方数`);
  const scale = maxV <= 1.0001 ? 1 : maxV <= 255.0001 ? 255 : maxV <= 1023.0001 ? 1023 : maxV <= 4095.0001 ? 4095 : 65535;

  const data = new Float32Array(N * N * N * 3);
  for (let r = 0; r < N; r++) for (let g = 0; g < N; g++) for (let b = 0; b < N; b++) {
    const src = rows[(r * N + g) * N + b];
    const dst = ((b * N + g) * N + r) * 3;
    data[dst] = src[0] / scale;
    data[dst + 1] = src[1] / scale;
    data[dst + 2] = src[2] / scale;
  }
  return { size: N, data, size1: 0, data1: null, dmin: [0, 0, 0], dmax: [1, 1, 1] };
}

function parseLut(text, ext) {
  ext = (ext || "cube").toLowerCase();
  if (ext === "3dl") return parse3dl(text);
  if (ext === "cube") return parseCube(text);
  throw new Error("暂不支持 ." + ext + " 格式的预览");
}

function lookup1D(t, size1, d1, ch) {
  const m = size1 - 1;
  let x = t * m;
  x = x < 0 ? 0 : x > m ? m : x;
  const i0 = x | 0;
  const i1 = i0 < m ? i0 + 1 : m;
  const f = x - i0;
  return d1[i0 * 3 + ch] * (1 - f) + d1[i1 * 3 + ch] * f;
}

// mix: 0~1，1 = 完全应用 LUT
function applyLUT(src, lut, mix) {
  const N = lut.size;
  const d = lut.data;
  const has3 = !!d;
  const m = N - 1;
  const s1 = N * 3;
  const s2 = N * N * 3;
  const dmin = lut.dmin, dmax = lut.dmax;
  const rng = [dmax[0] - dmin[0], dmax[1] - dmin[1], dmax[2] - dmin[2]];
  const d1 = lut.data1, size1 = lut.size1;
  const out = new Uint8Array(src.length);
  const len = src.length;
  const t = [0, 0, 0];

  for (let i = 0; i < len; i += 3) {
    for (let ch = 0; ch < 3; ch++) {
      let v = (src[i + ch] / 255 - dmin[ch]) / rng[ch];
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      if (d1) v = lookup1D(v, size1, d1, ch);
      t[ch] = v;
    }

    if (!has3) {
      for (let ch = 0; ch < 3; ch++) {
        let v = t[ch];
        if (mix < 1) { const o = src[i + ch] / 255; v = o + (v - o) * mix; }
        v = v < 0 ? 0 : v > 1 ? 1 : v;
        out[i + ch] = (v * 255 + 0.5) | 0;
      }
      continue;
    }

    let r = t[0] * m, g = t[1] * m, b = t[2] * m;
    r = r < 0 ? 0 : r > m ? m : r;
    g = g < 0 ? 0 : g > m ? m : g;
    b = b < 0 ? 0 : b > m ? m : b;

    const r0 = r | 0, g0 = g | 0, b0 = b | 0;
    const r1 = r0 < m ? r0 + 1 : m;
    const g1 = g0 < m ? g0 + 1 : m;
    const b1 = b0 < m ? b0 + 1 : m;
    const fr = r - r0, fg = g - g0, fb = b - b0;

    // red 变化最快：index = (b*N*N + g*N + r) * 3
    const o000 = b0 * s2 + g0 * s1 + r0 * 3;
    const o100 = b0 * s2 + g0 * s1 + r1 * 3;
    const o010 = b0 * s2 + g1 * s1 + r0 * 3;
    const o110 = b0 * s2 + g1 * s1 + r1 * 3;
    const o001 = b1 * s2 + g0 * s1 + r0 * 3;
    const o101 = b1 * s2 + g0 * s1 + r1 * 3;
    const o011 = b1 * s2 + g1 * s1 + r0 * 3;
    const o111 = b1 * s2 + g1 * s1 + r1 * 3;

    for (let ch = 0; ch < 3; ch++) {
      const c00 = d[o000 + ch] * (1 - fr) + d[o100 + ch] * fr;
      const c10 = d[o010 + ch] * (1 - fr) + d[o110 + ch] * fr;
      const c01 = d[o001 + ch] * (1 - fr) + d[o101 + ch] * fr;
      const c11 = d[o011 + ch] * (1 - fr) + d[o111 + ch] * fr;
      const c0 = c00 * (1 - fg) + c10 * fg;
      const c1 = c01 * (1 - fg) + c11 * fg;
      let v = c0 * (1 - fb) + c1 * fb;

      if (mix < 1) {
        const o = src[i + ch] / 255;
        v = o + (v - o) * mix;
      }
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      out[i + ch] = (v * 255 + 0.5) | 0;
    }
  }
  return out;
}

// ---------- 把 LUT 转成 ICC DeviceLink 配置文件（颜色查找图层渲染时需要它） ----------
function evalLut(lut, rgb, out) {
  const N = lut.size, d = lut.data, m = N - 1;
  const t = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    let v = (rgb[ch] - lut.dmin[ch]) / (lut.dmax[ch] - lut.dmin[ch]);
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    if (lut.data1) v = lookup1D(v, lut.size1, lut.data1, ch);
    t[ch] = v;
  }
  if (!d) { out[0] = t[0]; out[1] = t[1]; out[2] = t[2]; return; }
  const p = [0, 0, 0], i0 = [0, 0, 0], i1 = [0, 0, 0], f = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    let x = t[ch] * m; x = x < 0 ? 0 : x > m ? m : x;
    p[ch] = x; i0[ch] = x | 0; i1[ch] = i0[ch] < m ? i0[ch] + 1 : m; f[ch] = x - i0[ch];
  }
  const idx = (r, g, b) => (r + g * N + b * N * N) * 3;
  for (let ch = 0; ch < 3; ch++) {
    const c000 = d[idx(i0[0], i0[1], i0[2]) + ch], c100 = d[idx(i1[0], i0[1], i0[2]) + ch];
    const c010 = d[idx(i0[0], i1[1], i0[2]) + ch], c110 = d[idx(i1[0], i1[1], i0[2]) + ch];
    const c001 = d[idx(i0[0], i0[1], i1[2]) + ch], c101 = d[idx(i1[0], i0[1], i1[2]) + ch];
    const c011 = d[idx(i0[0], i1[1], i1[2]) + ch], c111 = d[idx(i1[0], i1[1], i1[2]) + ch];
    const c00 = c000 * (1 - f[0]) + c100 * f[0], c10 = c010 * (1 - f[0]) + c110 * f[0];
    const c01 = c001 * (1 - f[0]) + c101 * f[0], c11 = c011 * (1 - f[0]) + c111 * f[0];
    const c0 = c00 * (1 - f[1]) + c10 * f[1], c1 = c01 * (1 - f[1]) + c11 * f[1];
    out[ch] = c0 * (1 - f[2]) + c1 * f[2];
  }
}

// 生成 ICC v4 DeviceLink（RGB→RGB），A2B0 为 'mAB '：恒等曲线 + 16 位 CLUT（R 变化最慢）
function buildIccDeviceLink(lut, name, grid) {
  const G = grid || 33;
  const clutBytes = 20 + G * G * G * 3 * 2;
  const clutPad = (4 - (clutBytes % 4)) % 4;
  const mabLen = 32 + 36 + clutBytes + clutPad + 36;
  const mluc = (str) => {
    const n = str.length * 2;
    const b = new Uint8Array(28 + n + ((4 - (n % 4)) % 4));
    const dv = new DataView(b.buffer);
    b.set([0x6d, 0x6c, 0x75, 0x63]);
    dv.setUint32(8, 1); dv.setUint32(12, 12);
    b.set([0x65, 0x6e, 0x55, 0x53], 16);
    dv.setUint32(20, n); dv.setUint32(24, 28);
    for (let i = 0; i < str.length; i++) dv.setUint16(28 + i * 2, str.charCodeAt(i));
    return b;
  };
  const desc = mluc(String(name || "LUT").replace(/[^\x20-\x7e]/g, "_"));
  const cprt = mluc("Generated");
  const pseq = new Uint8Array(12);
  pseq.set([0x70, 0x73, 0x65, 0x71]);

  const mab = new Uint8Array(mabLen);
  const mv = new DataView(mab.buffer);
  mab.set([0x6d, 0x41, 0x42, 0x20]);
  mab[8] = 3; mab[9] = 3;
  const offB = 32, offClut = 68, offA = 68 + clutBytes + clutPad;
  mv.setUint32(12, offB); mv.setUint32(16, 0); mv.setUint32(20, 0); mv.setUint32(24, offClut); mv.setUint32(28, offA);
  const curv = (o) => { mab.set([0x63, 0x75, 0x72, 0x76], o); }; // count = 0 → 恒等
  curv(offB); curv(offB + 12); curv(offB + 24);
  curv(offA); curv(offA + 12); curv(offA + 24);
  for (let i = 0; i < 3; i++) mab[offClut + i] = G; // 每个输入通道的网格点数
  mab[offClut + 16] = 2; // 16 位
  let p = offClut + 20;
  const rgb = [0, 0, 0], o = [0, 0, 0];
  for (let r = 0; r < G; r++) for (let g = 0; g < G; g++) for (let b = 0; b < G; b++) {
    rgb[0] = r / (G - 1); rgb[1] = g / (G - 1); rgb[2] = b / (G - 1);
    evalLut(lut, rgb, o);
    for (let ch = 0; ch < 3; ch++) {
      let v = o[ch]; v = v < 0 ? 0 : v > 1 ? 1 : v;
      mv.setUint16(p, Math.round(v * 65535)); p += 2;
    }
  }

  const sigs = ["desc", "cprt", "pseq", "A2B0", "A2B1", "A2B2"];
  const bodies = [desc, cprt, pseq, mab, null, null];
  let off = 128 + 4 + sigs.length * 12;
  const offs = [], lens = [];
  for (let i = 0; i < sigs.length; i++) {
    if (bodies[i]) { offs.push(off); lens.push(bodies[i].length); off += bodies[i].length; }
    else { offs.push(offs[3]); lens.push(lens[3]); }
  }
  const out = new Uint8Array(off);
  const dv = new DataView(out.buffer);
  const asc = (s, at) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
  dv.setUint32(0, off);
  asc("ADBE", 4);
  out[8] = 4; out[9] = 0x20;
  asc("link", 12); asc("RGB ", 16); asc("RGB ", 20);
  dv.setUint16(24, 2026); dv.setUint16(26, 1); dv.setUint16(28, 1);
  asc("acsp", 36);
  dv.setUint32(68, 0xF6D6); dv.setUint32(72, 0x10000); dv.setUint32(76, 0xD32D);
  dv.setUint32(128, sigs.length);
  for (let i = 0; i < sigs.length; i++) {
    asc(sigs[i], 132 + i * 12);
    dv.setUint32(136 + i * 12, offs[i]);
    dv.setUint32(140 + i * 12, lens[i]);
    if (bodies[i]) out.set(bodies[i], offs[i]);
  }
  return out;
}

function toBase64(u8) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let s = "";
  const n = u8.length;
  for (let i = 0; i < n; i += 3) {
    const a = u8[i], b = i + 1 < n ? u8[i + 1] : 0, c = i + 2 < n ? u8[i + 2] : 0;
    s += A[a >> 2] + A[((a & 3) << 4) | (b >> 4)] + (i + 1 < n ? A[((b & 15) << 2) | (c >> 6)] : "=") + (i + 2 < n ? A[c & 63] : "=");
  }
  return s;
}

module.exports = { parseCube, parse3dl, parseLut, applyLUT, buildIccDeviceLink, toBase64 };
