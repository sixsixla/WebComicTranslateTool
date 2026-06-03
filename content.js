// WebComicTranslate - Content Script
// 注入到目标网页，负责图片捕获、文字检测、图像替换

(function () {
  'use strict';

  // ==================== 远程日志（本地调试用） ====================
  const LOG_SERVER = 'http://localhost:8765/log';
  const LOG_ENABLED = true;

  function remoteLog(level, msg) {
    if (!LOG_ENABLED) return;
    try {
      fetch(LOG_SERVER, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level, msg: String(msg) }),
      }).catch(() => {}); // 静默失败，服务器没开也不影响
    } catch (e) {}
  }

  function logInfo(msg)  { console.log('[WCT]', msg);  remoteLog('INFO', msg); }
  function logWarn(msg)  { console.warn('[WCT]', msg); remoteLog('WARN', msg); }
  function logError(msg) { console.error('[WCT]', msg); remoteLog('ERROR', msg); }
  function logStep(msg)  { console.log('[WCT]', msg);  remoteLog('STEP', msg); }

  // 全局异常捕获
  window.addEventListener('error', (e) => {
    remoteLog('FATAL', `全局异常: ${e.message} @ ${e.filename}:${e.lineno}`);
  });

  // ==================== 页内状态提示器 ====================

  let statusEl = null;

  function ensureStatusEl() {
    if (statusEl) return statusEl;
    statusEl = document.createElement('div');
    statusEl.id = 'webcomic-status';
    statusEl.style.cssText = `
      position: fixed; bottom: 24px; right: 24px; z-index: 2147483647;
      background: #1a1a2e; color: #eee; padding: 12px 18px;
      border-radius: 10px; font-size: 14px; font-family: "Microsoft YaHei", sans-serif;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5); max-width: 400px;
      line-height: 1.6; transition: opacity 0.3s; pointer-events: none;
      display: none;
    `;
    document.body.appendChild(statusEl);
    return statusEl;
  }

  function showStatus(msg, isError) {
    const el = ensureStatusEl();
    el.textContent = (isError ? '❌ ' : '') + msg;
    el.style.display = 'block';
    el.style.opacity = '1';
    el.style.background = isError ? '#5a1a1a' : '#1a1a2e';
  }

  function updateStatus(msg) {
    const el = ensureStatusEl();
    el.textContent = msg;
    el.style.display = 'block';
    el.style.opacity = '1';
  }

  function hideStatus(delay) {
    setTimeout(() => {
      if (statusEl) {
        statusEl.style.opacity = '0';
        setTimeout(() => { if (statusEl) statusEl.style.display = 'none'; }, 300);
      }
    }, delay || 3000);
  }

  // 当前语言配置
  let config = {
    sourceLang: 'jpn',       // 源语言（OCR用）
    targetLang: 'zh-CN',     // 目标语言（翻译用）
    enabled: true,
  };

  // 加载配置
  chrome.storage.local.get(['sourceLang', 'targetLang', 'enabled'], (items) => {
    if (items.sourceLang) config.sourceLang = items.sourceLang;
    if (items.targetLang) config.targetLang = items.targetLang;
    if (items.enabled !== undefined) config.enabled = items.enabled;
  });

  // 监听配置变更
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.sourceLang) config.sourceLang = changes.sourceLang.newValue;
    if (changes.targetLang) config.targetLang = changes.targetLang.newValue;
    if (changes.enabled) config.enabled = changes.enabled.newValue;
  });

  // ==================== OCR 引擎管理 ====================

  let ocrWorker = null;
  let ocrReady = false;
  let ocrInitPromise = null;
  let tesseractLibLoaded = false;

  /**
   * 动态加载 tesseract.js 库（懒加载，仅首次调用时执行）
   */
  async function ensureTesseractLib() {
    if (tesseractLibLoaded) return;
    if (typeof Tesseract !== 'undefined') {
      tesseractLibLoaded = true;
      return;
    }
    logStep('加载 tesseract.js 库...');
    const url = chrome.runtime.getURL('lib/tesseract.min.js');
    const resp = await fetch(url);
    const code = await resp.text();
    eval(code);
    tesseractLibLoaded = true;
    logStep('tesseract.js 库加载完成');
  }

  /**
   * 初始化 Tesseract.js OCR Worker（全局单例，懒加载）
   * 首次调用时会下载语言包（~15MB），后续调用复用
   */
  async function initOCR(lang = 'jpn') {
    if (ocrReady && ocrWorker) return ocrWorker;
    if (ocrInitPromise) return ocrInitPromise;

    ocrInitPromise = (async () => {
      // 先确保 tesseract 库已加载
      await ensureTesseractLib();

      logStep('初始化 Tesseract OCR Worker...');

      const langMap = { jpn: 'jpn', eng: 'eng', chi_sim: 'chi_sim', kor: 'kor' };
      const tessLang = langMap[lang] || lang;

      showStatus('正下载 OCR 语言包 (~15MB)，首次加载需等待...');
      ocrWorker = await Tesseract.createWorker(tessLang, 1);

      ocrReady = true;
      logStep('OCR Worker 初始化完成');
      return ocrWorker;
    })();

    return ocrInitPromise;
  }

  /**
   * 对图片中的某个区域进行 OCR 识别
   * @param {CanvasRenderingContext2D} ctx - 完整图片的 canvas context
   * @param {Object} region - { x, y, width, height }
   * @returns {Promise<string>} 识别的文字
   */
  async function ocrRegion(ctx, region) {
    const worker = await initOCR(config.sourceLang);

    // 裁剪区域到小 canvas
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = region.width;
    cropCanvas.height = region.height;
    const cropCtx = cropCanvas.getContext('2d');
    cropCtx.drawImage(
      ctx.canvas,
      region.x, region.y, region.width, region.height,
      0, 0, region.width, region.height
    );

    // OCR 识别
    const { data } = await worker.recognize(cropCanvas);
    const text = data.text.replace(/\s+/g, '').trim();
    console.log(`[WebComicTranslate] OCR 区域 [${region.x},${region.y} ${region.width}x${region.height}]: "${text}"`);
    return text;
  }

  // ==================== 图片处理流水线 ====================

  /**
   * 步骤1: 从 img 元素获取图片像素数据
   * 通过 Background Worker fetch 图片绕过 CORS 限制
   */
  async function imageToImageData(img) {
    const src = img.src || img.getAttribute('src');

    // 如果是 data URL 或同源，直接使用原始 img
    if (src.startsWith('data:') || isSameOrigin(src)) {
      return imageToImageDataDirect(img);
    }

    // 跨域图片：通过 Background Worker fetch
    logStep('通过Background抓取跨域: ' + src.substring(0, 80));
    const response = await chrome.runtime.sendMessage({
      type: 'fetchImage',
      url: src
    });

    if (!response || !response.success) {
      throw new Error('图片抓取失败: ' + (response ? response.error : '未知错误'));
    }

    // 从 base64 创建新 Image（无跨域问题）
    const dataUrl = response.dataUrl;
    const newImg = new Image();
    await new Promise((resolve, reject) => {
      newImg.onload = resolve;
      newImg.onerror = () => reject(new Error('base64 图片加载失败'));
      newImg.src = dataUrl;
    });

    return imageToImageDataDirect(newImg);
  }

  /**
   * 从同源 img 直接获取像素数据（无需绕过 CORS）
   */
  function imageToImageDataDirect(img) {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return {
      imageData,
      canvas,
      ctx,
      width: canvas.width,
      height: canvas.height
    };
  }

  /**
   * 判断 URL 是否与当前页面同源
   */
  function isSameOrigin(url) {
    try {
      const parsed = new URL(url, location.href);
      return parsed.origin === location.origin;
    } catch {
      return false;
    }
  }

  /**
   * 步骤2: 简易文字区域检测
   * 针对漫画气泡——通常是白色/浅色背景上的深色文字
   * 使用连通域分析找出候选文字区域
   */
  function detectTextRegions(imageData) {
    const { width, height, data } = imageData;
    const regions = [];

    // 简化方案：用滑动窗口检测包含高对比度像素的区域
    const blockSize = 32;
    const visited = new Uint8Array(Math.ceil(width / blockSize) * Math.ceil(height / blockSize));

    for (let by = 0; by < height; by += blockSize) {
      for (let bx = 0; bx < width; bx += blockSize) {
        const blockIdx = Math.floor(by / blockSize) * Math.ceil(width / blockSize) + Math.floor(bx / blockSize);
        if (visited[blockIdx]) continue;

        // 统计块内亮度方差，文字区域通常有较大的局部方差
        let sumVariance = 0;
        let pixelCount = 0;
        const blockEndY = Math.min(by + blockSize, height);
        const blockEndX = Math.min(bx + blockSize, width);

        for (let y = by; y < blockEndY; y++) {
          for (let x = bx; x < blockEndX; x++) {
            const idx = (y * width + x) * 4;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];
            const gray = 0.299 * r + 0.587 * g + 0.114 * b;
            // 累积灰度值（简化为统计是否有足够暗的像素）
            if (gray < 80) { // 深色像素（可能是文字）
              pixelCount++;
            }
          }
        }

        // 如果深色像素占比合适（超过5%，少于60%），认为是文字区域
        const totalPixels = (blockEndY - by) * (blockEndX - bx);
        const darkRatio = pixelCount / totalPixels;

        if (darkRatio > 0.02 && darkRatio < 0.6) {
          // 扩展区域边界
          const region = expandTextRegion(imageData, bx, by, blockEndX, blockEndY);
          if (region) {
            regions.push(region);
            // 标记附近块为已访问
            markVisitedBlocks(visited, region, blockSize, width);
          }
        }
      }
    }

    // 合并重叠区域
    return mergeOverlappingRegions(regions);
  }

  function expandTextRegion(imageData, startX, startY, endX, endY) {
    const { width, height, data } = imageData;
    let minX = startX, minY = startY, maxX = endX, maxY = endY;
    let expanded = true;
    const maxExpandSteps = 10;
    let steps = 0;

    while (expanded && steps < maxExpandSteps) {
      expanded = false;
      steps++;

      // 向上扩展
      if (minY > 0) {
        let hasDark = false;
        for (let x = minX; x < maxX; x++) {
          const idx = ((minY - 1) * width + x) * 4;
          const gray = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
          if (gray < 100) { hasDark = true; break; }
        }
        if (hasDark) { minY--; expanded = true; }
      }

      // 向下扩展
      if (maxY < height) {
        let hasDark = false;
        for (let x = minX; x < maxX; x++) {
          const idx = (maxY * width + x) * 4;
          const gray = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
          if (gray < 100) { hasDark = true; break; }
        }
        if (hasDark) { maxY++; expanded = true; }
      }

      // 向左扩展
      if (minX > 0) {
        let hasDark = false;
        for (let y = minY; y < maxY; y++) {
          const idx = (y * width + (minX - 1)) * 4;
          const gray = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
          if (gray < 100) { hasDark = true; break; }
        }
        if (hasDark) { minX--; expanded = true; }
      }

      // 向右扩展
      if (maxX < width) {
        let hasDark = false;
        for (let y = minY; y < maxY; y++) {
          const idx = (y * width + maxX) * 4;
          const gray = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
          if (gray < 100) { hasDark = true; break; }
        }
        if (hasDark) { maxX++; expanded = true; }
      }
    }

    const regionWidth = maxX - minX;
    const regionHeight = maxY - minY;

    // 过滤掉过小或过大的区域
    if (regionWidth < 10 || regionHeight < 8) return null;
    if (regionWidth > width * 0.9 && regionHeight > height * 0.9) return null;

    return {
      x: minX,
      y: minY,
      width: regionWidth,
      height: regionHeight,
    };
  }

  function markVisitedBlocks(visited, region, blockSize, imageWidth) {
    const blocksPerRow = Math.ceil(imageWidth / blockSize);
    const startBlockX = Math.floor(region.x / blockSize);
    const startBlockY = Math.floor(region.y / blockSize);
    const endBlockX = Math.floor((region.x + region.width) / blockSize);
    const endBlockY = Math.floor((region.y + region.height) / blockSize);

    for (let by = startBlockY; by <= endBlockY; by++) {
      for (let bx = startBlockX; bx <= endBlockX; bx++) {
        const idx = by * blocksPerRow + bx;
        if (idx < visited.length) visited[idx] = 1;
      }
    }
  }

  function mergeOverlappingRegions(regions) {
    if (regions.length <= 1) return regions;

    // 按面积从大到小排序
    regions.sort((a, b) => (b.width * b.height) - (a.width * a.height));

    const merged = [];
    const used = new Set();

    for (let i = 0; i < regions.length; i++) {
      if (used.has(i)) continue;

      let current = { ...regions[i] };
      used.add(i);

      for (let j = i + 1; j < regions.length; j++) {
        if (used.has(j)) continue;

        const other = regions[j];
        // 检查是否重叠
        const overlapX = Math.max(0, Math.min(current.x + current.width, other.x + other.width) - Math.max(current.x, other.x));
        const overlapY = Math.max(0, Math.min(current.y + current.height, other.y + other.height) - Math.max(current.y, other.y));

        if (overlapX > 0 && overlapY > 0) {
          // 合并
          const newX = Math.min(current.x, other.x);
          const newY = Math.min(current.y, other.y);
          current = {
            x: newX,
            y: newY,
            width: Math.max(current.x + current.width, other.x + other.width) - newX,
            height: Math.max(current.y + current.height, other.y + other.height) - newY,
          };
          used.add(j);
        }
      }

      merged.push(current);
    }

    return merged;
  }

  /**
   * 从区域背景采样主色调（用于填充擦除）
   */
  function sampleBackgroundColor(imageData, region) {
    const { width, data } = imageData;
    let rSum = 0, gSum = 0, bSum = 0, count = 0;

    // 采样区域边缘像素（避开中间的文字）
    const margin = 2;
    const { x, y, width: rw, height: rh } = region;

    // 顶部和底部边缘
    for (let sx = x + margin; sx < x + rw - margin; sx++) {
      for (let dy = 0; dy < 3; dy++) {
        const idxTop = ((y + dy) * width + sx) * 4;
        rSum += data[idxTop]; gSum += data[idxTop + 1]; bSum += data[idxTop + 2];
        const idxBottom = ((y + rh - 1 - dy) * width + sx) * 4;
        rSum += data[idxBottom]; gSum += data[idxBottom + 1]; bSum += data[idxBottom + 2];
        count += 2;
      }
    }

    // 左右边缘
    for (let sy = y + margin; sy < y + rh - margin; sy++) {
      for (let dx = 0; dx < 3; dx++) {
        const idxLeft = (sy * width + (x + dx)) * 4;
        rSum += data[idxLeft]; gSum += data[idxLeft + 1]; bSum += data[idxLeft + 2];
        const idxRight = (sy * width + (x + rw - 1 - dx)) * 4;
        rSum += data[idxRight]; gSum += data[idxRight + 1]; bSum += data[idxRight + 2];
        count += 2;
      }
    }

    if (count === 0) return { r: 255, g: 255, b: 255 };

    return {
      r: Math.round(rSum / count),
      g: Math.round(gSum / count),
      b: Math.round(bSum / count),
    };
  }

  /**
   * 步骤3: 在 Canvas 上擦除原文并绘制翻译文字
   */
  function renderTranslation(ctx, region, translatedText, bgColor) {
    const { x, y, width, height } = region;
    const padding = 4;

    // 填充背景色覆盖原文
    ctx.fillStyle = `rgb(${bgColor.r},${bgColor.g},${bgColor.b})`;
    ctx.fillRect(x - padding, y - padding, width + padding * 2, height + padding * 2);

    // 计算合适的字体大小
    const maxWidth = width + padding * 2;
    let fontSize = Math.min(14, height * 0.9);
    ctx.font = `${fontSize}px sans-serif`;
    const metrics = ctx.measureText(translatedText);

    // 如果文字太宽，缩小字体
    if (metrics.width > maxWidth && metrics.width > 0) {
      fontSize = fontSize * (maxWidth / metrics.width);
      fontSize = Math.max(8, fontSize);
    }

    // 绘制翻译文字
    ctx.fillStyle = '#000000';
    ctx.font = `bold ${fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`;
    ctx.textBaseline = 'middle';

    // 居中绘制
    const textX = x + width / 2;
    const textY = y + height / 2;

    // 简单换行处理
    const lines = wrapText(ctx, translatedText, maxWidth);
    let startY = textY - ((lines.length - 1) * fontSize * 0.6);

    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], textX, startY + i * fontSize * 1.2);
    }
  }

  function wrapText(ctx, text, maxWidth) {
    const words = text.split('');
    const lines = [];
    let currentLine = '';

    for (const char of words) {
      const testLine = currentLine + char;
      const metrics = ctx.measureText(testLine);
      if (metrics.width > maxWidth && currentLine.length > 0) {
        lines.push(currentLine);
        currentLine = char;
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) lines.push(currentLine);
    return lines.length > 0 ? lines : [text];
  }

  /**
   * 步骤4: 通过 background worker 翻译
   */
  function translateText(text) {
    // Tesseract 语言代码 → Google Translate 语言代码映射
    const langMap = { jpn: 'ja', eng: 'en', chi_sim: 'zh-CN', kor: 'ko' };
    const translateSource = langMap[config.sourceLang] || 'ja';
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: 'translate',
          text: text,
          sourceLang: translateSource,
          targetLang: config.targetLang,
        },
        (response) => {
          if (response && response.success) {
            resolve(response.text);
          } else {
            reject(new Error(response ? response.error : '翻译失败'));
          }
        }
      );
    });
  }

  // ==================== 调试工具 ====================

  /**
   * 在 canvas 上绘制检测到的文字区域框（调试用）
   */
  function drawDebugRegions(ctx, regions) {
    const colors = ['#ff0000', '#00ff00', '#0000ff', '#ff8800', '#ff00ff', '#00ffff'];
    regions.forEach((region, i) => {
      const color = colors[i % colors.length];
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.strokeRect(region.x, region.y, region.width, region.height);
      ctx.fillStyle = color;
      ctx.font = 'bold 12px monospace';
      ctx.fillText(`#${i + 1}`, region.x + 2, region.y + 14);
    });
    console.log(`[WebComicTranslate] 检测到 ${regions.length} 个文字区域`, regions);
  }

  // ==================== 对外接口 ====================

  /**
   * 处理单张图片的完整流水线
   * @param {number} imgIndex 图片序号（批量处理用），可选
   * @param {number} totalImgs 总图片数（批量处理用），可选
   */
  async function processImage(img, imgIndex, totalImgs) {
    if (!config.enabled) return;

    const prefix = totalImgs ? `[${imgIndex}/${totalImgs}] ` : '';

    // 步骤1: 获取图片数据
    showStatus(`${prefix}正在下载图片...`);
    const { canvas, ctx, imageData, width, height } = await imageToImageData(img);

    // 步骤2: 检测文字区域
    updateStatus(`${prefix}检测文字区域中... (${width}×${height})`);
    const regions = detectTextRegions(imageData);
    if (regions.length === 0) {
      updateStatus(`${prefix}未检测到文字区域，跳过`);
      return;
    }
    updateStatus(`${prefix}检测到 ${regions.length} 个文字区域`);

    // 步骤3: 对每个区域进行 OCR 识别
    const ocrResults = [];
    for (let i = 0; i < regions.length; i++) {
      updateStatus(`${prefix}OCR 识别中... (${i + 1}/${regions.length})`);
      try {
        const text = await ocrRegion(ctx, regions[i]);
        ocrResults.push({ region: regions[i], text });
      } catch (e) {
        console.warn(`[WebComicTranslate] 区域 #${i} OCR 失败:`, e);
        ocrResults.push({ region: regions[i], text: '' });
      }
    }

    // 过滤掉空结果的区域
    const validResults = ocrResults.filter(r => r.text.length > 0);
    if (validResults.length === 0) {
      updateStatus(`${prefix}OCR 无有效结果，跳过`);
      return;
    }

    // 步骤4: 翻译 + 步骤5: 擦除并渲染
    for (let i = 0; i < validResults.length; i++) {
      const result = validResults[i];
      updateStatus(`${prefix}翻译中... (${i + 1}/${validResults.length})`);
      try {
        result.translated = await translateText(result.text);
      } catch (e) {
        console.warn('[WebComicTranslate] 翻译失败:', e);
        result.translated = result.text;
      }

      const bgColor = sampleBackgroundColor(imageData, result.region);
      renderTranslation(ctx, result.region, result.translated, bgColor);
    }

    // 步骤6: 替换图片到 DOM
    canvas.style.width = img.style.width || img.width + 'px';
    canvas.style.height = img.style.height || img.height + 'px';
    canvas.style.maxWidth = '100%';
    canvas.classList.add('webcomic-translated');
    img.replaceWith(canvas);
    logStep('翻译完成，图片已替换');
  }

  // ==================== 鼠标悬停翻译模式 ====================
  // 作为 MVP 的简易实现：用户右键点击图片触发翻译

  let hoveredImg = null;

  document.addEventListener('contextmenu', (e) => {
    const target = e.target;
    if (target.tagName === 'IMG') {
      hoveredImg = target;
    }
  });

  // 找页面上的最佳候选图片（优先大图、可见图）
  function findBestImage() {
    // 优先用右键选中的
    if (hoveredImg && hoveredImg.isConnected) return hoveredImg;

    const images = document.querySelectorAll('img');
    if (images.length === 0) return null;

    // 按面积排序，找最大可见的图片
    let best = null;
    let bestScore = 0;
    for (const img of images) {
      const rect = img.getBoundingClientRect();
      const visible = rect.width > 50 && rect.height > 50 &&
        rect.bottom > 0 && rect.top < window.innerHeight;
      const score = img.naturalWidth * img.naturalHeight * (visible ? 2 : 1);
      if (score > bestScore) {
        bestScore = score;
        best = img;
      }
    }
    return best;
  }

  // 点击扩展图标发送的消息
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'translateCurrentImage') {
      const targetImg = findBestImage();
      if (!targetImg) {
        showStatus('页面没有找到图片', true);
        hideStatus(3000);
        sendResponse({ success: false, error: '页面没有找到图片' });
        return;
      }
      showStatus('开始翻译图片...');
      processImage(targetImg).then(() => {
        updateStatus('✅ 翻译完成！图片已替换');
        hideStatus(3000);
        sendResponse({ success: true });
      }).catch((err) => {
        showStatus(`翻译失败: ${err.message}`, true);
        hideStatus(5000);
        sendResponse({ success: false, error: err.message });
      });
      return true;
    }

    if (message.type === 'translateAllImages') {
      const images = document.querySelectorAll('img');
      if (images.length === 0) {
        showStatus('页面没有图片', true);
        hideStatus(3000);
        sendResponse({ success: true, count: 0 });
        return true;
      }
      // 顺序处理避免 OCR Worker 并发冲突
      (async () => {
        let processed = 0;
        let translated = 0;
        showStatus(`开始处理 ${images.length} 张图片...`);
        for (let i = 0; i < images.length; i++) {
          updateStatus(`处理图片 ${i + 1}/${images.length}...`);
          try {
            await processImage(images[i], i + 1, images.length);
            processed++;
            translated++;
          } catch (err) {
            logWarn('图片处理失败: ' + err.message);
            processed++;
          }
        }
        updateStatus(`✅ 完成！处理 ${processed} 张，翻译了 ${translated} 张`);
        hideStatus(4000);
        sendResponse({ success: true, count: translated });
      })();
      return true;
    }

    if (message.type === 'translateImageByUrl') {
      // 右键菜单触发：根据 URL 找到图片元素
      const images = document.querySelectorAll('img');
      let targetImg = null;
      for (const img of images) {
        if (img.src === message.url || img.getAttribute('src') === message.url) {
          targetImg = img;
          break;
        }
      }
      if (!targetImg) {
        showStatus('未找到对应图片', true);
        hideStatus(3000);
        return;
      }
      showStatus('开始翻译图片...');
      processImage(targetImg).then(() => {
        updateStatus('✅ 翻译完成！');
        hideStatus(3000);
      }).catch((err) => {
        showStatus(`翻译失败: ${err.message}`, true);
        hideStatus(5000);
      });
    }
  });

  // ==================== 启动自检 ====================

  logInfo('✅ Content script 已加载 — 版本 0.1.0');
  logInfo('页面: ' + location.href);
  logInfo('图片数量: ' + document.querySelectorAll('img').length);
  logInfo('使用: 1)右键图片→翻译  2)点图标→翻译当前  3)点图标→翻译全部');

  // 视觉确认标记：加载成功后在左上角闪一下
  try {
    const badge = document.createElement('div');
    badge.textContent = 'WCT ✓';
    badge.style.cssText = 'position:fixed;top:8px;left:8px;z-index:2147483647;' +
      'background:#22c55e;color:#fff;padding:4px 10px;border-radius:6px;' +
      'font-size:12px;font-family:sans-serif;transition:opacity 1.5s;opacity:1;';
    document.body.appendChild(badge);
    setTimeout(() => { badge.style.opacity = '0'; }, 800);
    setTimeout(() => { badge.remove(); }, 2500);
  } catch(e) {
    logWarn('无法创建启动标记: ' + e.message);
  }
})();
