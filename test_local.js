// test_local.js — WebComicTranslate 本地测试脚本
// 用法: node test_local.js <输入图片路径> [输出图片路径]
// 示例: node test_local.js test_images/manga_ja.png output.png

const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const Tesseract = require('tesseract.js');
const fs = require('fs');
const path = require('path');

// ==================== 配置 ====================

const CONFIG = {
  sourceLang: 'jpn',       // OCR 源语言
  translateFrom: 'ja',      // 翻译源语言代码
  translateTo: 'zh-CN',     // 翻译目标语言
  blockSize: 40,            // 文字检测块大小
  maxRegions: 60,           // 最大处理区域数
};

// ==================== 翻译 API ====================

async function translateText(text, from = 'ja', to = 'zh-CN') {
  const params = new URLSearchParams({
    client: 'gtx', sl: from, tl: to, dt: 't', q: text
  });
  const resp = await fetch(`https://translate.googleapis.com/translate_a/single?${params}`);
  const data = await resp.json();
  let result = '';
  if (data && data[0]) {
    for (const part of data[0]) {
      if (part[0]) result += part[0];
    }
  }
  return result || text;
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

  // 计算字号 (CJK 至少 12px)
  const maxWidth = width + padding * 2 - 4;
  let fontSize = Math.max(12, Math.min(16, height * 0.85));
  ctx.font = `${fontSize}px "SimHei", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif`;
  const metrics = ctx.measureText(text);

  if (metrics.width > maxWidth && metrics.width > 0) {
    fontSize = Math.max(11, fontSize * (maxWidth / metrics.width));
  }

  ctx.font = `${fontSize}px "SimHei", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  const textX = x + width / 2;
  const textY = y + height / 2;
  const lines = wrapText(ctx, text, maxWidth);
  let startY = textY - ((lines.length - 1) * fontSize * 0.6);

  // 白色描边
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 3;
  for (let i = 0; i < lines.length; i++) {
    ctx.strokeText(lines[i], textX, startY + i * fontSize * 1.2);
  }

  // 深色文字
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
