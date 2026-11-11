use anyhow::{bail, Context, Result};
use serde_json::Value;
use std::{ffi::c_void, thread, time::Duration};

type Hwnd = *mut c_void;
type Bool = i32;
type Lparam = isize;

#[repr(C)]
#[derive(Clone, Copy)]
struct Rect { left: i32, top: i32, right: i32, bottom: i32 }
#[repr(C)]
#[derive(Clone, Copy)]
struct Point { x: i32, y: i32 }
#[repr(C)]
#[derive(Clone, Copy)]
struct MouseInput { dx: i32, dy: i32, mouse_data: u32, flags: u32, time: u32, extra: usize }
#[repr(C)]
#[derive(Clone, Copy)]
struct KeyboardInput { vk: u16, scan: u16, flags: u32, time: u32, extra: usize }
#[repr(C)]
#[derive(Clone, Copy)]
union InputUnion { mouse: MouseInput, keyboard: KeyboardInput }
#[repr(C)]
#[derive(Clone, Copy)]
struct Input { kind: u32, data: InputUnion }

#[link(name = "user32")]
extern "system" {
    fn SetProcessDPIAware() -> Bool;
    fn GetForegroundWindow() -> Hwnd;
    fn GetWindowRect(hwnd: Hwnd, rect: *mut Rect) -> Bool;
    fn IsWindowVisible(hwnd: Hwnd) -> Bool;
    fn GetCursorPos(point: *mut Point) -> Bool;
    fn SetCursorPos(x: i32, y: i32) -> Bool;
    fn EnumChildWindows(hwnd: Hwnd, callback: Option<unsafe extern "system" fn(Hwnd, Lparam) -> Bool>, param: Lparam) -> Bool;
    fn GetClassNameW(hwnd: Hwnd, name: *mut u16, max: i32) -> i32;
    fn SendInput(count: u32, inputs: *const Input, size: i32) -> u32;
}

const INPUT_MOUSE: u32 = 0;
const INPUT_KEYBOARD: u32 = 1;
const MOUSE_LEFT_DOWN: u32 = 0x0002;
const MOUSE_LEFT_UP: u32 = 0x0004;
const MOUSE_WHEEL: u32 = 0x0800;
const KEY_UP: u32 = 0x0002;
const KEY_UNICODE: u32 = 0x0004;
const VK_CONTROL: u16 = 0x11;
const VK_BACK: u16 = 0x08;
const VK_RETURN: u16 = 0x0D;
const VK_A: u16 = 0x41;
const WHEEL_DELTA: i32 = 120;

fn mouse_input(flags: u32, data: u32) -> Input {
    Input { kind: INPUT_MOUSE, data: InputUnion { mouse: MouseInput {
        dx: 0, dy: 0, mouse_data: data, flags, time: 0, extra: 0
    } } }
}
fn key_input(vk: u16, scan: u16, flags: u32) -> Input {
    Input { kind: INPUT_KEYBOARD, data: InputUnion { keyboard: KeyboardInput {
        vk, scan, flags, time: 0, extra: 0
    } } }
}
fn send(inputs: &[Input]) -> Result<()> {
    let sent = unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<Input>() as i32) };
    if sent != inputs.len() as u32 { bail!("SendInput 仅成功发送 {sent}/{} 个输入事件", inputs.len()); }
    Ok(())
}
fn key_tap(vk: u16) -> Result<()> {
    send(&[key_input(vk, 0, 0), key_input(vk, 0, KEY_UP)])
}
fn ctrl_a_backspace() -> Result<()> {
    send(&[
        key_input(VK_CONTROL, 0, 0), key_input(VK_A, 0, 0), key_input(VK_A, 0, KEY_UP),
        key_input(VK_CONTROL, 0, KEY_UP), key_input(VK_BACK, 0, 0), key_input(VK_BACK, 0, KEY_UP)
    ])
}
fn type_unicode(text: &str) -> Result<()> {
    for (index, character) in text.chars().enumerate() {
        for unit in character.encode_utf16() {
            send(&[
                key_input(0, unit, KEY_UNICODE),
                key_input(0, unit, KEY_UNICODE | KEY_UP)
            ])?;
        }
        let pause_ms = if "，。！？；：,.!?;:".contains(character) {
            85
        } else {
            18 + ((index * 17) % 35) as u64
        };
        thread::sleep(Duration::from_millis(pause_ms));
    }
    Ok(())
}
fn click_at(x: i32, y: i32) -> Result<()> {
    move_curve(x, y)?;
    thread::sleep(Duration::from_millis(70));
    send(&[mouse_input(MOUSE_LEFT_DOWN, 0)])?;
    thread::sleep(Duration::from_millis(55));
    send(&[mouse_input(MOUSE_LEFT_UP, 0)])
}
fn move_curve(target_x: i32, target_y: i32) -> Result<()> {
    let mut start = Point { x: 0, y: 0 };
    if unsafe { GetCursorPos(&mut start) } == 0 { bail!("无法读取当前鼠标位置"); }
    let dx = target_x - start.x;
    let dy = target_y - start.y;
    let distance = ((dx * dx + dy * dy) as f64).sqrt();
    let steps = ((distance / 18.0).ceil() as usize).clamp(12, 42);
    let bend = ((dx.abs() + dy.abs()) / 9).clamp(12, 70);
    let sign = if (dx + dy) % 2 == 0 { 1.0 } else { -1.0 };
    let c1x = start.x as f64 + dx as f64 * 0.28;
    let c1y = start.y as f64 + dy as f64 * 0.28 + bend as f64 * sign;
    let c2x = start.x as f64 + dx as f64 * 0.72;
    let c2y = start.y as f64 + dy as f64 * 0.72 - bend as f64 * sign * 0.55;
    for step in 1..=steps {
        let t = step as f64 / steps as f64;
        let u = 1.0 - t;
        let x = u.powi(3) * start.x as f64 + 3.0 * u.powi(2) * t * c1x
            + 3.0 * u * t.powi(2) * c2x + t.powi(3) * target_x as f64;
        let y = u.powi(3) * start.y as f64 + 3.0 * u.powi(2) * t * c1y
            + 3.0 * u * t.powi(2) * c2y + t.powi(3) * target_y as f64;
        if unsafe { SetCursorPos(x.round() as i32, y.round() as i32) } == 0 {
            bail!("设置鼠标位置失败");
        }
        thread::sleep(Duration::from_millis(7));
    }
    Ok(())
}

unsafe extern "system" fn collect_render(hwnd: Hwnd, param: Lparam) -> Bool {
    let mut name = [0_u16; 128];
    let len = GetClassNameW(hwnd, name.as_mut_ptr(), name.len() as i32);
    if len > 0 && IsWindowVisible(hwnd) != 0 {
        let class = String::from_utf16_lossy(&name[..len as usize]);
        if class == "Chrome_RenderWidgetHostHWND" {
            let mut rect = Rect { left: 0, top: 0, right: 0, bottom: 0 };
            if GetWindowRect(hwnd, &mut rect) != 0 {
                let area = i64::from(rect.right - rect.left) * i64::from(rect.bottom - rect.top);
                let found = &mut *(param as *mut Option<(Hwnd, i64)>);
                if found.as_ref().map(|(_, current_area)| area > *current_area).unwrap_or(true) {
                    *found = Some((hwnd, area));
                }
            }
        }
    }
    1
}
fn chrome_bounds() -> Result<(Rect, Rect)> {
    unsafe { SetProcessDPIAware(); }
    let top = unsafe { GetForegroundWindow() };
    if top.is_null() { bail!("没有前台浏览器窗口，请先激活 Chrome"); }
    let mut top_rect = Rect { left: 0, top: 0, right: 0, bottom: 0 };
    if unsafe { GetWindowRect(top, &mut top_rect) } == 0 { bail!("无法读取 Chrome 窗口位置"); }
    let mut render = None::<(Hwnd, i64)>;
    unsafe { EnumChildWindows(top, Some(collect_render), &mut render as *mut _ as Lparam); }
    let render = render.map(|(hwnd, _)| hwnd)
        .context("前台窗口中没有找到 Chrome 网页渲染区域；请激活 Chrome 网页标签后重试")?;
    let mut render_rect = Rect { left: 0, top: 0, right: 0, bottom: 0 };
    if unsafe { GetWindowRect(render, &mut render_rect) } == 0 { bail!("无法读取网页区域位置"); }
    Ok((top_rect, render_rect))
}
fn viewport_point(params: &Value, render: Rect) -> Result<(i32, i32)> {
    let scale = params.get("scale").and_then(Value::as_f64).unwrap_or(1.0).clamp(0.5, 4.0);
    let x = params.get("x").and_then(Value::as_f64).context("缺少鼠标 x 坐标")? * scale;
    let y = params.get("y").and_then(Value::as_f64).context("缺少鼠标 y 坐标")? * scale;
    let width = render.right - render.left;
    let height = render.bottom - render.top;
    if x < 0.0 || y < 0.0 || x >= width as f64 || y >= height as f64 {
        bail!("目标坐标超出当前 Chrome 网页可视区域");
    }
    Ok((render.left + x.round() as i32, render.top + y.round() as i32))
}

pub fn execute(params: &Value) -> Result<Value> {
    let action = params.get("action").and_then(Value::as_str).unwrap_or("");
    match action {
        "click" | "type_text" | "scroll" => {
            let (_, render) = chrome_bounds()?;
            let (x, y) = viewport_point(params, render)?;
            match action {
                "click" => click_at(x, y)?,
                "type_text" => {
                    click_at(x, y)?;
                    thread::sleep(Duration::from_millis(120));
                    if params.get("clear_first").and_then(Value::as_bool).unwrap_or(true) {
                        ctrl_a_backspace()?;
                        thread::sleep(Duration::from_millis(80));
                    }
                    let text = params.get("text").and_then(Value::as_str).context("缺少输入文本")?;
                    type_unicode(text)?;
                }
                "scroll" => {
                    move_curve(x, y)?;
                    let mut remaining = params.get("delta_y").and_then(Value::as_i64).unwrap_or(0).clamp(-4000, 4000) as i32;
                    while remaining != 0 {
                        let step = remaining.clamp(-WHEEL_DELTA, WHEEL_DELTA);
                        let data = (-step.signum() * WHEEL_DELTA) as i32 as u32;
                        send(&[mouse_input(MOUSE_WHEEL, data)])?;
                        remaining -= step;
                        thread::sleep(Duration::from_millis(90));
                    }
                }
                _ => unreachable!()
            }
            Ok(serde_json::json!({"performed": true, "action": action}))
        }
        "navigate" => {
            let (window, _) = chrome_bounds()?;
            let url = params.get("url").and_then(Value::as_str).context("缺少网址")?;
            if url.len() > 2048 || !(url.starts_with("https://") || url.starts_with("http://")) {
                bail!("仅允许输入有效的 HTTP/HTTPS 网址");
            }
            let x = (window.left + window.right) / 2;
            let y = window.top + 90;
            click_at(x, y)?;
            thread::sleep(Duration::from_millis(100));
            // Ctrl+L guarantees address-bar focus even when browser toolbar metrics vary.
            send(&[key_input(VK_CONTROL, 0, 0), key_input(0x4C, 0, 0), key_input(0x4C, 0, KEY_UP), key_input(VK_CONTROL, 0, KEY_UP)])?;
            ctrl_a_backspace()?;
            type_unicode(url)?;
            thread::sleep(Duration::from_millis(100));
            key_tap(VK_RETURN)?;
            Ok(serde_json::json!({"performed": true, "action": "navigate"}))
        }
        _ => bail!("不支持的系统输入动作: {action}"),
    }
}
