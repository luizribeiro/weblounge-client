//! The macOS overlay title bar: the traffic lights drawn over the page's top-left corner, and
//! the band the page keeps free for them (design 35).

use serde::Serialize;
use tauri::{AppHandle, LogicalPosition, TitleBarStyle, WebviewWindowBuilder, Wry};

/// CSS px the page reserves at its top-left: `inline_start` wide, `block_size` tall.
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowControls {
    pub inline_start: u16,
    pub block_size: u16,
}

pub const WINDOW_CONTROLS: WindowControls = WindowControls {
    inline_start: 84,
    block_size: 48,
};

// AppKit positions each button's 12x14 frame, not its 12px circle, so these put the first
// circle 20px from the left with its centre 24px down, the midline of the 48px band.
const LIGHTS_FRAME_ORIGIN_X: f64 = 19.0;
const LIGHTS_FRAME_ORIGIN_Y: f64 = 22.0;

pub fn overlay(
    builder: WebviewWindowBuilder<'_, Wry, AppHandle>,
) -> WebviewWindowBuilder<'_, Wry, AppHandle> {
    builder
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(LogicalPosition::new(
            LIGHTS_FRAME_ORIGIN_X,
            LIGHTS_FRAME_ORIGIN_Y,
        ))
}
