// WebComicTranslate - Background Service Worker
// 处理翻译请求等需要网络请求的任务（避免 CORS 限制）

const TRANSLATE_API = 'https://translate.googleapis.com/translate_a/single';

// 翻译文本
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

// 消息处理
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'translate') {
    translateText(message.text, message.sourceLang, message.targetLang)
      .then(result => sendResponse({ success: true, text: result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // 保持消息通道打开（异步响应）
  }
});
