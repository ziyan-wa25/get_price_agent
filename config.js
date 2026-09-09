// 后端 API 地址：自动区分本地开发与线上部署，平时不需要改这个文件。
// - 本地（127.0.0.1 / localhost 打开前端）→ 连本地后端 http://127.0.0.1:8787
// - 线上（GitHub Pages 等域名打开）→ 连云函数公网 URL
// 云函数地址变更时，只改下面 CLOUD_API_BASE 一处即可。
window.APP_CONFIG = (function () {
  var CLOUD_API_BASE = 'https://1483863126-5a9fgz6c3g.ap-beijing.tencentscf.com';
  var isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  return {
    API_BASE: isLocal ? 'http://127.0.0.1:8787' : CLOUD_API_BASE,
  };
})();
