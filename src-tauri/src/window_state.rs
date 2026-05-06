use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Position, Runtime, WebviewWindow};

const WINDOW_STATE_SCHEMA_VERSION: u32 = 1;
const DEFAULT_WINDOW_MARGIN_PX: u32 = 64;
const DEFAULT_WINDOW_TOTAL_MARGIN_PX: u32 = DEFAULT_WINDOW_MARGIN_PX * 2;
const MIN_WINDOW_WIDTH: u32 = 1320;
const MIN_WINDOW_HEIGHT: u32 = 820;
const MAIN_WINDOW_LABEL: &str = "main";

#[derive(Default)]
pub struct WindowLifecycleState {
    is_quitting: AtomicBool,
}

impl WindowLifecycleState {
    pub fn mark_quitting(&self) {
        self.is_quitting.store(true, Ordering::SeqCst);
    }

    pub fn is_quitting(&self) -> bool {
        self.is_quitting.load(Ordering::SeqCst)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowStateFile {
    schema_version: u32,
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    fullscreen: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    updated_at: Option<String>,
}

#[derive(Debug, Clone, Copy)]
struct WindowRect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

pub fn apply_saved_or_default_window_state<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
) -> Result<(), String> {
    let monitor = resolve_current_or_primary_monitor(window)?;
    let monitor_name = monitor
        .name()
        .cloned()
        .unwrap_or_else(|| "<unnamed-monitor>".to_string());
    let work_area = monitor.work_area();
    println!(
        "[window] setup: monitor={} scale_factor={} work_area=({}, {}) {}x{}",
        monitor_name,
        monitor.scale_factor(),
        work_area.position.x,
        work_area.position.y,
        work_area.size.width,
        work_area.size.height
    );

    let state = load_window_state(app)?;
    let Some(state) = state else {
        println!("[window] setup: no cached window state, use default window");
        return apply_default_window(window, "no cached state");
    };

    println!(
        "[window] setup: loaded state width={} height={} x={} y={} fullscreen={}",
        state.width, state.height, state.x, state.y, state.fullscreen
    );

    if state.fullscreen {
        println!(
            "[window] setup: cached state requests fullscreen, prepare safe visible window first"
        );
        apply_default_window(window, "fullscreen restore baseline")?;
        println!("[window] setup: attempting fullscreen restore on current primary monitor");
        match window.set_fullscreen(true) {
            Ok(_) => {
                println!("[window] setup: fullscreen restore success");
                return Ok(());
            }
            Err(error) => {
                eprintln!("[window] setup: fullscreen restore failed: {error}");
                return apply_default_window(window, "fullscreen restore fallback");
            }
        }
    }

    match validate_saved_window_rect(window, &state) {
        Ok(Some(rect)) => {
            println!(
                "[window] setup: cached state is valid, restoring rect {}x{} at ({}, {})",
                rect.width, rect.height, rect.x, rect.y
            );
            apply_window_rect(window, rect)
        }
        Ok(None) => {
            println!("[window] setup: cached state is invalid, use default window");
            apply_default_window(window, "invalid cached state")
        }
        Err(error) => {
            eprintln!("[window] setup: failed to validate cached state: {error}");
            apply_default_window(window, "validation error fallback")
        }
    }
}

pub fn save_main_window_state<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
) -> Result<(), String> {
    let path = resolve_window_state_path(app)?;
    println!("[window] state: using state file {}", path.display());

    let position = window
        .outer_position()
        .map_err(|error| format!("读取窗口位置失败: {error}"))?;
    let size = window
        .inner_size()
        .map_err(|error| format!("读取窗口尺寸失败: {error}"))?;
    let fullscreen = window
        .is_fullscreen()
        .map_err(|error| format!("读取 fullscreen 状态失败: {error}"))?;

    let state = WindowStateFile {
        schema_version: WINDOW_STATE_SCHEMA_VERSION,
        width: size.width,
        height: size.height,
        x: position.x,
        y: position.y,
        fullscreen,
        updated_at: Some(Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
    };

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建窗口状态目录失败 {}: {error}", parent.display()))?;
    }

    let bytes = serde_json::to_vec_pretty(&state)
        .map_err(|error| format!("序列化窗口状态失败: {error}"))?;
    fs::write(&path, bytes)
        .map_err(|error| format!("写入窗口状态文件失败 {}: {error}", path.display()))?;

    println!(
        "[window] state: save success width={} height={} x={} y={} fullscreen={}",
        state.width, state.height, state.x, state.y, state.fullscreen
    );
    Ok(())
}

pub fn show_and_focus_main_window<R: Runtime>(app: &AppHandle<R>, reason: &str) {
    println!("[window] {reason}: attempting to show + focus main window");

    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        eprintln!("[window] {reason}: main window not found");
        return;
    };

    match window.show() {
        Ok(_) => println!("[window] {reason}: show success"),
        Err(error) => eprintln!("[window] {reason}: show failed: {error}"),
    }

    match window.set_focus() {
        Ok(_) => println!("[window] {reason}: set_focus success"),
        Err(error) => eprintln!("[window] {reason}: set_focus failed: {error}"),
    }
}

fn load_window_state<R: Runtime>(app: &AppHandle<R>) -> Result<Option<WindowStateFile>, String> {
    let path = resolve_window_state_path(app)?;
    println!("[window] state: using state file {}", path.display());

    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            println!("[window] state: no state file found");
            return Ok(None);
        }
        Err(error) => {
            return Err(format!("读取窗口状态文件失败 {}: {error}", path.display()));
        }
    };

    let state: WindowStateFile = serde_json::from_slice(&bytes)
        .map_err(|error| format!("解析窗口状态文件失败 {}: {error}", path.display()))?;

    if state.schema_version != WINDOW_STATE_SCHEMA_VERSION {
        eprintln!(
            "[window] state: unsupported schemaVersion={}, ignore cached state",
            state.schema_version
        );
        return Ok(None);
    }

    println!("[window] state: loaded cached state successfully");
    Ok(Some(state))
}

fn resolve_window_state_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法定位 app_config_dir 以保存窗口状态: {error}"))?;
    let file_name = if cfg!(debug_assertions) {
        "window-state.dev.json"
    } else {
        "window-state.json"
    };
    Ok(config_dir.join(file_name))
}

fn resolve_current_or_primary_monitor<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Result<tauri::Monitor, String> {
    if let Ok(Some(monitor)) = window.current_monitor() {
        println!("[window] setup: using current monitor");
        return Ok(monitor);
    }

    println!("[window] setup: current monitor unavailable, trying primary monitor");
    if let Ok(Some(monitor)) = window.primary_monitor() {
        return Ok(monitor);
    }

    window
        .available_monitors()
        .map_err(|error| format!("查询可用显示器失败: {error}"))?
        .into_iter()
        .next()
        .ok_or_else(|| "没有可用显示器".to_string())
}

fn apply_default_window<R: Runtime>(window: &WebviewWindow<R>, reason: &str) -> Result<(), String> {
    let monitor = resolve_current_or_primary_monitor(window)?;
    let work_area = monitor.work_area();

    let width = clamp_dimension(
        work_area.size.width,
        work_area
            .size
            .width
            .saturating_sub(DEFAULT_WINDOW_TOTAL_MARGIN_PX),
        MIN_WINDOW_WIDTH,
        "width",
    );
    let height = clamp_dimension(
        work_area.size.height,
        work_area
            .size
            .height
            .saturating_sub(DEFAULT_WINDOW_TOTAL_MARGIN_PX),
        MIN_WINDOW_HEIGHT,
        "height",
    );

    println!(
        "[window] setup: using default window for reason=\"{}\" target={}x{}",
        reason, width, height
    );

    window
        .set_fullscreen(false)
        .map_err(|error| format!("退出 fullscreen 失败: {error}"))?;
    window
        .set_size(PhysicalSize::new(width, height))
        .map_err(|error| format!("设置默认窗口尺寸失败: {error}"))?;
    center_window_in_work_area(
        window,
        work_area.position.x,
        work_area.position.y,
        work_area.size.width,
        work_area.size.height,
    )
    .map_err(|error| format!("居中默认窗口失败: {error}"))?;
    println!("[window] setup: default window applied and centered");
    Ok(())
}

fn apply_window_rect<R: Runtime>(
    window: &WebviewWindow<R>,
    rect: WindowRect,
) -> Result<(), String> {
    window
        .set_fullscreen(false)
        .map_err(|error| format!("恢复普通窗口前退出 fullscreen 失败: {error}"))?;
    window
        .set_size(PhysicalSize::new(rect.width, rect.height))
        .map_err(|error| format!("恢复窗口尺寸失败: {error}"))?;
    window
        .set_position(Position::Physical(PhysicalPosition::new(rect.x, rect.y)))
        .map_err(|error| format!("恢复窗口位置失败: {error}"))?;
    println!("[window] setup: restored ordinary window state successfully");
    Ok(())
}

fn validate_saved_window_rect<R: Runtime>(
    window: &WebviewWindow<R>,
    state: &WindowStateFile,
) -> Result<Option<WindowRect>, String> {
    if state.width == 0 || state.height == 0 {
        println!("[window] state: invalid state because width/height must be positive");
        return Ok(None);
    }

    let monitors = window
        .available_monitors()
        .map_err(|error| format!("查询可用显示器失败: {error}"))?;
    if monitors.is_empty() {
        println!("[window] state: no monitors available while validating state");
        return Ok(None);
    }

    let mut best_monitor = None;
    let mut best_score = 0_i64;
    let mut point_hit_monitor = None;
    let mut point_hit = false;

    for monitor in monitors {
        let work_area = monitor.work_area();
        let work_left = work_area.position.x as i64;
        let work_top = work_area.position.y as i64;
        let work_right = work_left + work_area.size.width as i64;
        let work_bottom = work_top + work_area.size.height as i64;

        let rect_left = state.x as i64;
        let rect_top = state.y as i64;
        let rect_right = rect_left + state.width as i64;
        let rect_bottom = rect_top + state.height as i64;

        let overlap_width = (rect_right.min(work_right) - rect_left.max(work_left)).max(0);
        let overlap_height = (rect_bottom.min(work_bottom) - rect_top.max(work_top)).max(0);
        let overlap_area = overlap_width * overlap_height;

        let point_inside = rect_left >= work_left
            && rect_left < work_right
            && rect_top >= work_top
            && rect_top < work_bottom;

        if point_inside {
            point_hit_monitor = Some(monitor.clone());
            point_hit = true;
            break;
        }

        if overlap_area > best_score {
            best_score = overlap_area;
            best_monitor = Some(monitor);
        }
    }

    let target_monitor = point_hit_monitor.or(best_monitor);
    let Some(target_monitor) = target_monitor else {
        println!("[window] state: invalid state because saved rect does not intersect any monitor");
        return Ok(None);
    };

    if !point_hit && best_score <= 0 {
        println!("[window] state: invalid state because saved rect has no positive overlap with any monitor");
        return Ok(None);
    }

    let work_area = target_monitor.work_area();
    let width = clamp_dimension(work_area.size.width, state.width, MIN_WINDOW_WIDTH, "width");
    let height = clamp_dimension(
        work_area.size.height,
        state.height,
        MIN_WINDOW_HEIGHT,
        "height",
    );

    let min_x = work_area.position.x;
    let min_y = work_area.position.y;
    let max_x = work_area.position.x + work_area.size.width as i32 - width as i32;
    let max_y = work_area.position.y + work_area.size.height as i32 - height as i32;

    let clamped_x = state.x.clamp(min_x, max_x.max(min_x));
    let clamped_y = state.y.clamp(min_y, max_y.max(min_y));

    println!(
        "[window] state: validated rect {}x{} at ({}, {})",
        width, height, clamped_x, clamped_y
    );

    Ok(Some(WindowRect {
        x: clamped_x,
        y: clamped_y,
        width,
        height,
    }))
}

fn clamp_dimension(work_area_dimension: u32, desired: u32, min_dimension: u32, axis: &str) -> u32 {
    if work_area_dimension < min_dimension {
        println!(
            "[window] state: current work_area {}={} is smaller than min {}, keep window inside screen",
            axis, work_area_dimension, min_dimension
        );
        return work_area_dimension;
    }

    desired.clamp(min_dimension, work_area_dimension)
}

fn center_window_in_work_area<R: Runtime>(
    window: &WebviewWindow<R>,
    work_x: i32,
    work_y: i32,
    work_width: u32,
    work_height: u32,
) -> Result<(), String> {
    let outer_size = window
        .outer_size()
        .map_err(|error| format!("读取窗口外框尺寸失败: {error}"))?;

    let horizontal_padding = work_width.saturating_sub(outer_size.width) / 2;
    let vertical_padding = work_height.saturating_sub(outer_size.height) / 2;

    let target_x = work_x.saturating_add(horizontal_padding as i32);
    let target_y = work_y.saturating_add(vertical_padding as i32);

    println!(
        "[window] setup: explicit center target outer_size={}x{} position=({}, {})",
        outer_size.width, outer_size.height, target_x, target_y
    );

    window
        .set_position(Position::Physical(PhysicalPosition::new(
            target_x, target_y,
        )))
        .map_err(|error| format!("设置显式居中位置失败: {error}"))?;

    Ok(())
}
