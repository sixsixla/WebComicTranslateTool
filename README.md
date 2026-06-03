# WebComicTranslate

Chrome 浏览器插件，实时翻译网页上漫画图片中的文字，在原位置替换显示。

## 功能

- 检测网页上的漫画图片
- OCR 识别图片中的文字（日语/英语/韩语/中文）
- 翻译为目标语言
- 在原位置渲染翻译后的文字

## 安装（开发模式）

1. 克隆本仓库
2. 打开 Chrome，访问 `chrome://extensions/`
3. 开启右上角「开发者模式」
4. 点击「加载已解压的扩展程序」，选择本仓库目录

## 使用

1. 在漫画网页上，右键点击要翻译的图片
2. 点击扩展图标，选择源语言和目标语言
3. 点击「翻译当前图片」或「翻译页面全部图片」

## 技术栈

- Chrome Extension Manifest V3
- Tesseract.js (OCR, 计划集成)
- Google Translate API (翻译)
- Canvas API (图像处理)
