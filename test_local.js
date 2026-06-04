// test_local.js — WebComicTranslate 本地测试脚本
// 用法: node test_local.js <输入图片路径> [输出图片路径]
// 示例: node test_local.js test_images/manga_ja.png output.png

const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const Tesseract = require('tesseract.js');
const fs = require('fs');
const path = require('path');

// ==================== 注册 CJK 字体 ====================

const CJK_FONT_FAMILY = 'SimHei';

function registerFonts() {
  const fontPaths = [
    'C:/Windows/Fonts/simhei.ttf',
    'C:/Windows/Fonts/msyh.ttc',
    'C:/Windows/Fonts/simsun.ttc',
  ];
  for (const fp of fontPaths) {
    if (fs.existsSync(fp)) {
      try {
        GlobalFonts.registerFromPath(fp, path.basename(fp, path.extname(fp)));
        console.log(`注册字体: ${fp}`);
      } catch (e) {
        console.log(`字体注册失败: ${fp} - ${e.message}`);
      }
    }
  }
  // 也尝试注册为通用别名
  try {
    if (fs.existsSync('C:/Windows/Fonts/simhei.ttf')) {
      GlobalFonts.registerFromPath('C:/Windows/Fonts/simhei.ttf', 'CJK');
    }
  } catch(e) {}
}

registerFonts();

// ==================== 配置 ====================

const CONFIG = loadConfig();
const _CONFIG_DEFAULTS = {
  sourceLang: 'jpn',       // OCR 源语言
  translateFrom: 'ja',      // 翻译源语言代码
  translateTo: 'zh-CN',     // 翻译目标语言
  blockSize: 40,            // 文字检测块大小
  maxRegions: 60,
  deepseekApiKey: '',
};

function loadConfig() {
  try {
    const user = JSON.parse(fs.readFileSync('config.json', 'utf-8'));
    return { ..._CONFIG_DEFAULTS, ...user };
  } catch(e) {
    console.log('config.json 未找到或格式错误，使用默认配置');
    return _CONFIG_DEFAULTS;
  }
}

// ==================== 翻译 API ====================


// DeepSeek 翻译（质量远超 MyMemory）
async function translateWithDeepSeek(text, from, to) {
  if (!CONFIG.deepseekApiKey) return null;
  const resp = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + CONFIG.deepseekApiKey,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{
        role: 'system',
        content: '你是漫画翻译助手。将日语翻译成自然流畅的中文。只输出翻译，不要解释、不要注音、不要括号。保持原文语气。'
      }, {
        role: 'user',
        content: text
      }],
      temperature: 0.3,
      max_tokens: 500,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await resp.json();
  if (data?.choices?.[0]?.message?.content) {
    return data.choices[0].message.content.trim();
  }
  return null;
}


async function translateText(text, from = 'ja', to = 'zh-CN') {
  // 方案1: DeepSeek（最佳质量）
  if (CONFIG.deepseekApiKey) {
    try {
      const result = await translateWithDeepSeek(text, from, to);
      if (result) return result;
    } catch (e) {}
  }

  // 方案2: Google
  try {
    const params = new URLSearchParams({ client: 'gtx', sl: from, tl: to, dt: 't', q: text });
    const resp = await fetch('https://translate.googleapis.com/translate_a/single?' + params, { signal: AbortSignal.timeout(5000) });
    const data = await resp.json();
    let result = '';
    if (data?.[0]) for (const p of data[0]) if (p[0]) result += p[0];
    if (result && result !== text) return result;
  } catch (e) {}

  // 方案3: MyMemory
  try {
    const resp = await fetch('https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) + '&langpair=' + from + '|' + to, { signal: AbortSignal.timeout(8000) });
    const data = await resp.json();
    if (data?.responseData?.translatedText) return data.responseData.translatedText;
  } catch (e) {}

  return text;
}

// ==================== OCR ====================

let ocrWorker = null;

async function initOCR(lang = 'jpn') {
  if (ocrWorker) return ocrWorker;
  console.log('初始化 Tesseract OCR Worker...');
  ocrWorker = await Tesseract.createWorker(lang, 1);
  console.log('OCR Worker 就绪');
  return ocrWorker;
}

async function ocrImage(imagePath) {
  const worker = await initOCR(CONFIG.sourceLang);
  const { data } = await worker.recognize(imagePath);
  return data.text.replace(/\s+/g, '').trim();
}

async function ocrRegionFromBuffer(buffer, width, height, region) {
  const worker = await initOCR(CONFIG.sourceLang);
  const { data } = await worker.recognize(buffer, {
    rectangle: {
      left: region.x,
      top: region.y,
      width: region.width,
      height: region.height,
    },
  });
  return data.text.replace(/\s+/g, '').trim();
}

// ==================== 文字区域检测 ====================

function detectTextRegions(imageData, imgWidth, imgHeight) {
  const { data } = imageData;
  const width = imgWidth;
  const height = imgHeight;
  const regions = [];
  const blockSize = CONFIG.blockSize;
  const visited = new Uint8Array(Math.ceil(width / blockSize) * Math.ceil(height / blockSize));

  for (let by = 0; by < height; by += blockSize) {
    for (let bx = 0; bx < width; bx += blockSize) {
      const blockIdx = Math.floor(by / blockSize) * Math.ceil(width / blockSize) + Math.floor(bx / blockSize);
      if (visited[blockIdx]) continue;

      let pixelCount = 0;
      const blockEndY = Math.min(by + blockSize, height);
      const blockEndX = Math.min(bx + blockSize, width);

      for (let y = by; y < blockEndY; y++) {
        for (let x = bx; x < blockEndX; x++) {
          const idx = (y * width + x) * 4;
          const gray = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
          if (gray < 80) pixelCount++;
        }
      }

      const totalPixels = (blockEndY - by) * (blockEndX - bx);
      const darkRatio = pixelCount / totalPixels;

      if (darkRatio > 0.05 && darkRatio < 0.5) {
        const region = expandTextRegion(data, width, height, bx, by, blockEndX, blockEndY);
        if (region) {
          regions.push(region);
          markVisitedBlocks(visited, region, blockSize, width);
        }
      }
    }
  }

  let merged = mergeOverlappingRegions(regions);

  // 碎片合并：将相邻小区域合并成完整文字行
  merged = mergeIntoTextLines(merged, width);

  merged.sort((a, b) => (b.width * b.height) - (a.width * a.height));
  if (merged.length > CONFIG.maxRegions) {
    console.log(`  区域过多 (${merged.length})，截断到 ${CONFIG.maxRegions} 个`);
    merged = merged.slice(0, CONFIG.maxRegions);
  }
  return merged;
}

function expandTextRegion(data, width, height, startX, startY, endX, endY) {
  let minX = startX, minY = startY, maxX = endX, maxY = endY;
  let expanded = true;
  let steps = 0;

  while (expanded && steps < 10) {
    expanded = false; steps++;

    if (minY > 0) {
      let hasDark = false;
      for (let x = minX; x < maxX; x++) {
        const idx = ((minY - 1) * width + x) * 4;
        if (0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2] < 100) { hasDark = true; break; }
      }
      if (hasDark) { minY--; expanded = true; }
    }
    if (maxY < height) {
      let hasDark = false;
      for (let x = minX; x < maxX; x++) {
        const idx = (maxY * width + x) * 4;
        if (0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2] < 100) { hasDark = true; break; }
      }
      if (hasDark) { maxY++; expanded = true; }
    }
    if (minX > 0) {
      let hasDark = false;
      for (let y = minY; y < maxY; y++) {
        const idx = (y * width + (minX - 1)) * 4;
        if (0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2] < 100) { hasDark = true; break; }
      }
      if (hasDark) { minX--; expanded = true; }
    }
    if (maxX < width) {
      let hasDark = false;
      for (let y = minY; y < maxY; y++) {
        const idx = (y * width + maxX) * 4;
        if (0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2] < 100) { hasDark = true; break; }
      }
      if (hasDark) { maxX++; expanded = true; }
    }
  }

  const rw = maxX - minX, rh = maxY - minY;
  if (rw < 10 || rh < 8) return null;
  if (rw > width * 0.9 && rh > height * 0.9) return null;

  // 气泡白底检查
  if (!isLikelyBubble(data, width, height, { x: minX, y: minY, width: rw, height: rh })) return null;

  return { x: minX, y: minY, width: rw, height: rh };
}

function isLikelyBubble(data, width, height, region) {
  const { x, y, width: rw, height: rh } = region;
  const border = 6;
  let whiteCount = 0, totalCount = 0;

  for (let sx = Math.max(0, x - border); sx < Math.min(width, x + rw + border); sx++) {
    for (let dy = 0; dy < border; dy++) {
      const ty = y - border + dy;
      if (ty >= 0) {
        const idx = (ty * width + sx) * 4;
        if (0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2] > 220) whiteCount++;
        totalCount++;
      }
      const by = y + rh + dy;
      if (by < height) {
        const idx = (by * width + sx) * 4;
        if (0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2] > 220) whiteCount++;
        totalCount++;
      }
    }
  }
  for (let sy = y; sy < y + rh; sy++) {
    for (let dx = 0; dx < border; dx++) {
      const lx = x - border + dx;
      if (lx >= 0) {
        const idx = (sy * width + lx) * 4;
        if (0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2] > 220) whiteCount++;
        totalCount++;
      }
      const rx = x + rw + dx;
      if (rx < width) {
        const idx = (sy * width + rx) * 4;
        if (0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2] > 220) whiteCount++;
        totalCount++;
      }
    }
  }
  return totalCount > 0 && (whiteCount / totalCount) > 0.6;
}

function markVisitedBlocks(visited, region, blockSize, imageWidth) {
  const bpr = Math.ceil(imageWidth / blockSize);
  const sbx = Math.floor(region.x / blockSize), sby = Math.floor(region.y / blockSize);
  const ebx = Math.floor((region.x + region.width) / blockSize), eby = Math.floor((region.y + region.height) / blockSize);
  for (let by = sby; by <= eby; by++)
    for (let bx = sbx; bx <= ebx; bx++) {
      const idx = by * bpr + bx;
      if (idx < visited.length) visited[idx] = 1;
    }
}

function mergeOverlappingRegions(regions) {
  if (regions.length <= 1) return regions;
  regions.sort((a, b) => (b.width * b.height) - (a.width * a.height));
  const merged = [];
  const used = new Set();
  for (let i = 0; i < regions.length; i++) {
    if (used.has(i)) continue;
    let cur = { ...regions[i] };
    used.add(i);
    for (let j = i + 1; j < regions.length; j++) {
      if (used.has(j)) continue;
      const o = regions[j];
      const ox = Math.max(0, Math.min(cur.x + cur.width, o.x + o.width) - Math.max(cur.x, o.x));
      const oy = Math.max(0, Math.min(cur.y + cur.height, o.y + o.height) - Math.max(cur.y, o.y));
      if (ox > 0 && oy > 0) {
        const nx = Math.min(cur.x, o.x), ny = Math.min(cur.y, o.y);
        cur = { x: nx, y: ny, width: Math.max(cur.x + cur.width, o.x + o.width) - nx, height: Math.max(cur.y + cur.height, o.y + o.height) - ny };
        used.add(j);
      }
    }
    merged.push(cur);
  }
  return merged;
}

/**
 * 碎片合并：将相邻的小区域合并成完整文字气泡
 * 支持竖排（日语漫画）和横排两种模式
 */
function mergeIntoTextLines(regions, imgWidth) {
  if (regions.length <= 1) return regions;

  const sorted = [...regions].sort((a, b) => a.y - b.y || a.x - b.x);
  const merged = [];
  const used = new Set();

  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue;

    let cur = { ...sorted[i] };
    used.add(i);
    let changed = true;

    while (changed) {
      changed = false;
      for (let j = 0; j < sorted.length; j++) {
        if (used.has(j)) continue;
        const o = sorted[j];

        // 竖排合并：x重叠且y接近
        const xOverlap = Math.max(0,
          Math.min(cur.x + cur.width, o.x + o.width) - Math.max(cur.x, o.x));
        const yGap = Math.max(cur.y, o.y) - Math.min(cur.y + cur.height, o.y + o.height);
        const vMerge = xOverlap > Math.min(cur.width, o.width) * 0.3 &&
                       yGap < Math.max(cur.height, o.height) * 0.8;

        // 横排合并：y重叠且x接近
        const yOverlap = Math.max(0,
          Math.min(cur.y + cur.height, o.y + o.height) - Math.max(cur.y, o.y));
        const xGap = Math.max(cur.x, o.x) - Math.min(cur.x + cur.width, o.x + o.width);
        const hMerge = yOverlap > Math.min(cur.height, o.height) * 0.3 &&
                       xGap < Math.max(cur.width, o.width) * 0.6;

        if (vMerge || hMerge) {
          const nx = Math.min(cur.x, o.x);
          const ny = Math.min(cur.y, o.y);
          cur = {
            x: nx, y: ny,
            width: Math.max(cur.x + cur.width, o.x + o.width) - nx,
            height: Math.max(cur.y + cur.height, o.y + o.height) - ny,
          };
          used.add(j);
          changed = true;
        }
      }
    }
    merged.push(cur);
  }
  return merged;
}

// ==================== 渲染 ====================

function sampleBackgroundColor(imageData, region, imgWidth) {
  const { data } = imageData;
  const { x, y, width: rw, height: rh } = region;
  let rSum = 0, gSum = 0, bSum = 0, count = 0;
  const margin = 2;

  for (let sx = x + margin; sx < x + rw - margin; sx++) {
    for (let dy = 0; dy < 3; dy++) {
      const it = ((y + dy) * imgWidth + sx) * 4;
      rSum += data[it]; gSum += data[it + 1]; bSum += data[it + 2];
      const ib = ((y + rh - 1 - dy) * imgWidth + sx) * 4;
      rSum += data[ib]; gSum += data[ib + 1]; bSum += data[ib + 2];
      count += 2;
    }
  }
  for (let sy = y + margin; sy < y + rh - margin; sy++) {
    for (let dx = 0; dx < 3; dx++) {
      const il = (sy * imgWidth + (x + dx)) * 4;
      rSum += data[il]; gSum += data[il + 1]; bSum += data[il + 2];
      const ir = (sy * imgWidth + (x + rw - 1 - dx)) * 4;
      rSum += data[ir]; gSum += data[ir + 1]; bSum += data[ir + 2];
      count += 2;
    }
  }
  if (count === 0) return { r: 255, g: 255, b: 255 };
  return { r: Math.round(rSum / count), g: Math.round(gSum / count), b: Math.round(bSum / count) };
}

function renderTranslation(ctx, region, text, bgColor) {
  const { x, y, width, height } = region;
  const padding = 2;

  // 半透明背景覆盖
  ctx.fillStyle = `rgba(${bgColor.r},${bgColor.g},${bgColor.b},0.92)`;
  ctx.fillRect(x - padding, y - padding, width + padding * 2, height + padding * 2);

  // 判断竖排/横排：高>宽1.5倍 → 竖排（日语漫画标准）
  const isVertical = height > width * 1.5;

  if (isVertical) {
    renderVerticalText(ctx, x, y, width, height, text, padding);
  } else {
    renderHorizontalText(ctx, x, y, width, height, text, padding);
  }
}

function renderVerticalText(ctx, bx, by, bw, bh, text, pad) {
  let fontSize = Math.max(14, Math.min(bw * 0.85, bh * 0.08));
  ctx.font = `${fontSize}px "${CJK_FONT_FAMILY}", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const maxCharsPerCol = Math.max(1, Math.floor((bh - pad * 2) / (fontSize * 1.15)));
  const chars = text.replace(/\s+/g, '').split('');
  const columns = [];
  for (let i = 0; i < chars.length; i += maxCharsPerCol) {
    columns.push(chars.slice(i, i + maxCharsPerCol));
  }

  const numCols = columns.length;
  let columnWidth = Math.min(fontSize * 1.3, (bw - pad * 2) / Math.max(numCols, 1));
  const totalColWidth = numCols * columnWidth;
  let colX = bx + bw / 2 + totalColWidth / 2 - columnWidth / 2;

  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.fillStyle = '#111111';

  for (let ci = 0; ci < numCols; ci++) {
    const colChars = columns[ci];
    let charY = by + bh / 2 - ((colChars.length - 1) * fontSize * 1.15) / 2;
    for (let ri = 0; ri < colChars.length; ri++) {
      ctx.strokeText(colChars[ri], colX, charY + ri * fontSize * 1.15);
      ctx.fillText(colChars[ri], colX, charY + ri * fontSize * 1.15);
    }
    colX -= columnWidth;
  }
}

function renderHorizontalText(ctx, bx, by, bw, bh, text, pad) {
  const maxWidth = bw + pad * 2 - 4;
  let fontSize = Math.max(14, Math.min(bh * 0.12, bw * 0.9));
  ctx.font = `${fontSize}px "${CJK_FONT_FAMILY}", sans-serif`;
  const metrics = ctx.measureText(text);
  if (metrics.width > maxWidth && metrics.width > 0) {
    fontSize = Math.max(11, fontSize * (maxWidth / metrics.width));
  }
  ctx.font = `${fontSize}px "${CJK_FONT_FAMILY}", sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  const textX = bx + bw / 2;
  const textY = by + bh / 2;
  const lines = wrapText(ctx, text, maxWidth);
  let startY = textY - ((lines.length - 1) * fontSize * 0.6);

  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 3;
  for (let i = 0; i < lines.length; i++) {
    ctx.strokeText(lines[i], textX, startY + i * fontSize * 1.2);
  }
  ctx.fillStyle = '#111111';
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], textX, startY + i * fontSize * 1.2);
  }
}

function wrapText(ctx, text, maxWidth) {
  const chars = text.split('');
  const lines = [];
  let cur = '';
  for (const ch of chars) {
    const test = cur + ch;
    if (ctx.measureText(test).width > maxWidth && cur.length > 0) {
      lines.push(cur);
      cur = ch;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines.length > 0 ? lines : [text];
}

// ==================== 主流程 ====================

async function processImage(inputPath, outputPath) {
  console.log(`\n======== 处理图片: ${inputPath} ========`);

  // 1. 加载图片
  console.log('1. 加载图片...');
  const img = await loadImage(inputPath);
  const width = img.width;
  const height = img.height;
  console.log(`   尺寸: ${width}×${height}`);

  // 创建 Canvas 并绘制图片
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, width, height);

  // 2. 检测文字区域
  console.log('2. 检测文字区域...');
  const regions = detectTextRegions(imageData, width, height);
  console.log(`   检测到 ${regions.length} 个文字区域`);
  if (regions.length === 0) {
    console.log('   未检测到文字区域，退出');
    return;
  }

  // 3. 对每个区域 OCR
  console.log('3. OCR 识别...');
  const imgBuffer = fs.readFileSync(inputPath);
  const ocrResults = [];
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i];
    try {
      const text = await ocrRegionFromBuffer(imgBuffer, width, height, r);
      const display = text.length > 30 ? text.substring(0, 30) + '...' : text;
      console.log(`   [${i + 1}/${regions.length}] (${r.x},${r.y} ${r.width}×${r.height}): "${display}"`);
      ocrResults.push({ region: r, text });
    } catch (e) {
      console.log(`   [${i + 1}/${regions.length}] OCR 失败: ${e.message}`);
      ocrResults.push({ region: r, text: '' });
    }
  }

  // 4. 过滤空结果
  const validResults = ocrResults.filter(r => r.text.length > 0);
  console.log(`   有效 OCR 结果: ${validResults.length}/${ocrResults.length}`);
  if (validResults.length === 0) return;

  // 5. 翻译 + 渲染
  console.log('4. 翻译并渲染...');
  for (let i = 0; i < validResults.length; i++) {
    const r = validResults[i];
    try {
      r.translated = await translateText(r.text, CONFIG.translateFrom, CONFIG.translateTo);
      console.log(`   [${i + 1}/${validResults.length}] "${r.text.substring(0, 20)}" → "${r.translated}"`);
    } catch (e) {
      console.log(`   [${i + 1}/${validResults.length}] 翻译失败: ${e.message}`);
      r.translated = r.text;
    }
    const bgColor = sampleBackgroundColor(imageData, r.region, width);
    renderTranslation(ctx, r.region, r.translated, bgColor);
  }

  // 6. 保存结果
  console.log('5. 保存结果...');
  const pngBuffer = canvas.toBuffer('image/png');
  fs.writeFileSync(outputPath, pngBuffer);
  console.log(`   已保存: ${outputPath}`);

  // 7. 自动化验证 — 中文 OCR 回读输出图
  console.log('6. 自动化验证...');
  try {
    const verifyWorker = await Tesseract.createWorker('chi_sim', 1);
    const { data: verifyData } = await verifyWorker.recognize(pngBuffer);
    const chineseChars = (verifyData.text.match(/[\u4e00-\u9fff]/g) || []).length;
    const verifyConfidence = verifyData.confidence;
    console.log(`   中文OCR置信度: ${verifyConfidence}%`);
    console.log(`   检测到中文字符: ${chineseChars} 个`);
    
    if (verifyConfidence > 50 && chineseChars > 10) {
      console.log(`   ✅ 渲染质量: 合格（中文可读）`);
    } else if (verifyConfidence > 30 || chineseChars > 5) {
      console.log(`   ⚠️ 渲染质量: 差（可能需要调整字体/字号）`);
    } else {
      console.log(`   ❌ 渲染质量: 不合格（中文不可读，可能是字体问题）`);
    }
    await verifyWorker.terminate();
  } catch (e) {
    console.log(`   验证失败: ${e.message}`);
  }

  console.log('======== 完成 ========\n');
}

// ==================== 入口 ====================

(async () => {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log('用法: node test_local.js <输入图片> [输出图片]');
    console.log('示例: node test_local.js test_images/manga.png output.png');
    console.log('\n请将测试图片放入 test_images/ 目录');
    process.exit(1);
  }

  const inputPath = args[0];
  const outputPath = args[1] || inputPath.replace(/\.(jpg|jpeg|png|webp)$/i, '_translated.png');

  if (!fs.existsSync(inputPath)) {
    console.error(`错误: 文件不存在 — ${inputPath}`);
    process.exit(1);
  }

  try {
    await processImage(inputPath, outputPath);
  } catch (e) {
    console.error('处理失败:', e);
    process.exit(1);
  }
})();
