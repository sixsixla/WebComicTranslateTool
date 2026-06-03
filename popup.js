// WebComicTranslate - Popup Script

document.addEventListener('DOMContentLoaded', () => {
  const sourceLang = document.getElementById('sourceLang');
  const targetLang = document.getElementById('targetLang');
  const translateCurrentBtn = document.getElementById('translateCurrent');
  const translateAllBtn = document.getElementById('translateAll');
  const statusEl = document.getElementById('status');

  // 加载保存的配置
  chrome.storage.local.get(['sourceLang', 'targetLang'], (items) => {
    if (items.sourceLang) sourceLang.value = items.sourceLang;
    if (items.targetLang) targetLang.value = items.targetLang;
  });

  // 保存配置
  sourceLang.addEventListener('change', () => {
    chrome.storage.local.set({ sourceLang: sourceLang.value });
  });

  targetLang.addEventListener('change', () => {
    chrome.storage.local.set({ targetLang: targetLang.value });
  });

  // 发送消息的封装，带超时
  async function sendToTab(type, timeout = 5000) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('请求超时，Content Script 未响应')), timeout);
      chrome.tabs.sendMessage(tab.id, { type }, (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  }

  // 翻译当前可见的最大图片
  translateCurrentBtn.addEventListener('click', async () => {
    statusEl.textContent = '正在翻译...';
    try {
      const response = await sendToTab('translateCurrentImage');
      if (response && response.success) {
        statusEl.textContent = '✅ 翻译完成！页面右下角有进度提示';
      } else {
        statusEl.textContent = '⚠️ ' + (response ? response.error : '未找到可翻译的图片');
      }
    } catch (e) {
      statusEl.textContent = '❌ ' + e.message;
    }
  });

  // 翻译全部图片
  translateAllBtn.addEventListener('click', async () => {
    statusEl.textContent = '正在翻译所有图片...';
    try {
      const response = await sendToTab('translateAllImages', 30000);
      if (response && response.success) {
        statusEl.textContent = `✅ 已处理 ${response.count} 张图片`;
      } else {
        statusEl.textContent = '⚠️ ' + (response ? response.error : '翻译未完成');
      }
    } catch (e) {
      statusEl.textContent = '❌ ' + e.message;
    }
  });
});
