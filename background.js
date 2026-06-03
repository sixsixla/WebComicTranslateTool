// WebComicTranslate - Background Service Worker
// 处理翻译请求、图片抓取等需要网络请求的任务（避免 CORS 限制）

const TRANSLATE_API = 'https://translate.googleapis.com/translate_a/single';

// ==================== 图片抓取 ====================

/**
 * 将 ArrayBuffer 转为 base64 data URL
 */
function arrayBufferToDataUrl(buffer, mimeType) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  return `data:${mimeType};base64,${base64}`;
}

/**
 * 抓取图片 URL，返回 base64 data URL
 * Service Worker 中 fetch 不受 CORS 限制
 */
async function fetchImage(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`图片抓取失败: HTTP ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  const mimeType = response.headers.get('content-type') || 'image/png';
  return arrayBufferToDataUrl(buffer, mimeType);
}

// ==================== 翻译 ====================

async function translateText(text, sourceLang = 'ja', targetLang = 'zh-CN') {
  const params = new URLSearchParams({
    client: 'gtx',
    sl: sourceLang,
    tl: targetLang,
    dt: 't',
    q: text
  });

  const response = await fetch(`${TRANSLATE_API}?${params}`);
  const data = await response.json();

  // 解析 Google Translate 返回格式
  let translated = '';
  if (data && data[0]) {
    for (const part of data[0]) {
      if (part[0]) {
        translated += part[0];
      }
    }
  }
  return translated;
}

// ==================== 消息路由 ====================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'fetchImage') {
    fetchImage(message.url)
      .then(dataUrl => sendResponse({ success: true, dataUrl }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'translate') {
    translateText(message.text, message.sourceLang, message.targetLang)
      .then(result => sendResponse({ success: true, text: result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});
