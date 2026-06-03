# WebComicTranslate 详细实施计划

## 总体架构

```
┌──────────────────────────────────────────────────┐
│                   Chrome Extension                 │
│                                                    │
│  popup.html/js  ──→  background.js  ──→ 翻译API   │
│  (控制面板)          (Service Worker)   (Google)   │
│       │                    ↑                      │
│       │ chrome.tabs       │ chrome.runtime        │
│       │ .sendMessage      │ .sendMessage          │
│       ▼                    │                      │
│  content.js  ─────────────────────────────────    │
│  (注入到目标网页)                                  │
│                                                    │
│  流水线:                                          │
│  Img → Canvas捕获 → 文字检测 → OCR → 翻译         │
│       → Inpainting → 渲染中文 → 替换DOM           │
└──────────────────────────────────────────────────┘
```

## 技术选型

| 模块 | 技术 | 选型原因 |
|------|------|----------|
| 文字检测 | 传统CV（滑动窗口+方差统计） | 不需要模型下载，对白底气泡效果好 |
| OCR | Tesseract.js v5 + jpn.traineddata | 浏览器端运行，免费，支持日语 |
| 翻译 | Google Translate 免费接口 | 无需API Key，免费 |
| 图像修复 | 背景色填充 | 简单有效，针对纯色气泡 |
| 文字渲染 | Canvas 2D API | 原生支持，无需额外依赖 |

## Step 1: 图片捕获模块

**目标**: 确保能从任意 `<img>` 元素正确提取像素数据。

**实现**:
1. 点击扩展图标 → 获取当前右键选中的 `<img>` 元素
2. 创建离屏 Canvas，drawImage 绘制原始图片
3. 通过 getImageData 获取 RGBA 像素数组

**成功标准**: Console 能看到图片的宽高和像素数据。

**风险**: 跨域图片可能污染 Canvas，导致 getImageData 报错。
**应对**: 
- 方案A: 设置 img.crossOrigin = "anonymous"（需要服务端支持CORS）
- 方案B: 通过 background worker fetch 图片（绕过跨域限制）
- 优先使用方案B

---

## Step 2: 简易文字区域检测

**目标**: 在漫画图片中检测出文字气泡区域。

**方法**: 滑动窗口 + 局部方差统计 + 区域扩展

**详细算法**:
1. 将图片分割为 32x32 的块
2. 每块统计深色像素（灰度<80）的比例
3. 深色像素占比在 2%-60% 之间的块标记为候选文字块
4. 对候选块进行四方向扩展：如果相邻行/列有深色像素，扩展区域
5. 合并重叠区域，过滤掉过小（<10x8px）和过大（>90%图片）的区域

**成功标准**: 在典型漫画页面上能框出大部分文字气泡，无明显漏检。

**风险**: 对非白底气泡（如深色背景）效果差。
**应对**: 后续阶段支持手动框选区域。

**风险**: 检测到的区域包含气泡框线而非纯文字区域。
**应对**: 可接受，后续 OCR 会忽略非文字内容。

---

## Step 3: 集成 Tesseract.js OCR

**目标**: 识别检测到的文字区域中的日语文字。

**实现**:
1. 下载 Tesseract.js v5 (tesseract.js@5)
2. 下载日语训练数据 `jpn.traineddata` (~15MB)
3. 将训练数据放入 `lib/` 目录，通过 web_accessible_resources 暴露
4. 对每个检测区域裁剪子图 → 传给 Tesseract 识别
5. 返回识别的日语文本

**API 调用**:
```js
import Tesseract from 'tesseract.js';
const worker = await Tesseract.createWorker('jpn');
const { data: { text } } = await worker.recognize(canvas);
```

**成功标准**: 从裁剪后的气泡图片中正确识别出日文假名和汉字。

**风险**: Tesseract.js 包体积大，首次加载慢（~20秒）。
**应对**: 
- 显示加载进度提示
- worker 复用（一次初始化，多次识别）
- 后续可考虑使用 manga-ocr（准确率更高但体积更大）

**风险**: 竖排文字识别率低。
**应对**: 后续阶段考虑旋转预处理或专用竖排OCR。

---

## Step 4: 翻译接口联调

**目标**: Content Script 调用 Background Worker 完成翻译。

**实现**:
1. Content Script 发送 `{ type: 'translate', text, sourceLang, targetLang }`
2. Background Worker 调用 Google Translate API
3. 返回翻译结果给 Content Script

**API**: `https://translate.googleapis.com/translate_a/single?client=gtx&sl=ja&tl=zh-CN&dt=t&q=TEXT`

**成功标准**: 日文输入 → 中文输出，无网络错误。

**风险**: Google API 可能限流或变更。
**应对**: 
- 添加请求间隔（200ms）
- 预留多种翻译后端接口

---

## Step 5: 图像修复 + 文字渲染

**目标**: 在原气泡位置擦除原文、绘制中文翻译。

**实现**:
1. **采样背景色**: 取气泡区域边缘3px像素，计算平均颜色
2. **擦除**: 用背景色填充整个气泡区域（+4px padding）
3. **计算字号**: 根据气泡宽度和文字长度自动缩放，最小8px
4. **绘制**: Canvas fillText，居中，粗体，黑色

**成功标准**: 气泡区域被背景色填平，中文文字居中显示且不溢出。

**风险**: 非纯色背景（渐变、纹理）填充效果不好。
**应对**: 先用纯色填充作为第一版，后续可接 LaMa 等轻量 inpainting 模型。

**风险**: 中文文字过长，气泡放不下。
**应对**: 自动缩小字号 + 自动换行。

---

## Step 6: 图片替换回 DOM

**目标**: 将处理后的 Canvas 替换原 `<img>` 元素。

**实现**:
1. Canvas 设置与原图相同的 CSS 尺寸
2. 添加 `.webcomic-translated` class（蓝色边框标记）
3. 调用 `img.replaceWith(canvas)`

**成功标准**: 页面上的漫画图片被翻译后的 Canvas 替代，布局不变。

---

## Step 7: 真实页面测试

**目标**: 在真实漫画网站测试完整流水线。

**测试场景**:
- 白底气泡漫画页面
- 单张大图和切分的多张小图
- 不同分辨率

**问题收集与修复**

---

## Step 8: UI 完善 + 交互优化

**目标**: 提升用户体验。

**内容**:
- 加载进度提示（OCR 模型加载、翻译中）
- 显示/隐藏翻译的切换按钮
- 翻译后 hover 显示原文的 tooltip
- 错误提示优化

---

## Step 9: 缓存机制

**目标**: 避免重复翻译同一张图片。

**方法**: 对图片 URL + 语言对 做 hash，翻译结果缓存到 chrome.storage.local。

---

## 变更记录

| 日期 | 步骤 | 变更说明 |
|------|------|----------|
| 2026-06-03 | - | 初始计划创建 |
