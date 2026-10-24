// 鑫潮海办公系统桌面壳：窗口内嵌 frontend/ 静态界面，API 直接打到腾讯云后端（与网页版同一数据源）。
// 不注入任何本地数据逻辑——所有权限/校验都在服务端，桌面版与网页版天然同步。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
