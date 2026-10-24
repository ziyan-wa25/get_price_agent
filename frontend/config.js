// 后端 API 地址：自动区分本地开发与线上部署，平时不需要改这个文件。
// - 本地（127.0.0.1 / localhost 打开前端）→ 连本地后端 http://127.0.0.1:8787
// - 线上（GitHub Pages 等域名打开）→ 连云函数公网 URL
// 云函数地址变更时，只改下面 CLOUD_API_BASE 一处即可。
window.APP_CONFIG = (function () {
  var CLOUD_API_BASE = 'https://1483863126-5a9fgz6c3g.ap-beijing.tencentscf.com';
  // 桌面版（Tauri）：请求走应用内置转发（Rust 直连云端），无 CORS 限制。
  // 自定义协议 URL 因平台而异：Windows/Android 为 http(s)://api.localhost（随 useHttpsScheme），macOS/Linux 为 api://localhost
  var isTauri = !!(window.__TAURI_INTERNALS__ || window.__TAURI__);
  if (isTauri) {
    document.documentElement.classList.add('tauri-app'); // 桌面端整体缩放 0.9，与网页视觉比例一致
    var isWinLike = /Windows|Android/i.test(navigator.userAgent);
    return { API_BASE: isWinLike ? 'https://api.localhost' : 'api://localhost' };
  }
  var isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  return {
    API_BASE: isLocal ? 'http://127.0.0.1:8787' : CLOUD_API_BASE,
  };
})();
