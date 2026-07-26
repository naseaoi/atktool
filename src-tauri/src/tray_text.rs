#[cfg(target_os = "windows")]
mod platform {
    use windows::{
        core::w,
        Win32::{
            Foundation::RECT,
            Graphics::Gdi::{
                CreateCompatibleDC, CreateDIBSection, CreateFontW, DeleteDC, DeleteObject,
                DrawTextW, SelectObject, SetBkMode, SetTextColor, BITMAPINFO, BITMAPINFOHEADER,
                BI_RGB, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DIB_RGB_COLORS,
                DT_CALCRECT, DT_LEFT, DT_NOCLIP, DT_SINGLELINE, DT_TOP, FF_DONTCARE, FW_SEMIBOLD,
                HBITMAP, HDC, HGDIOBJ, OUT_TT_PRECIS, TRANSPARENT,
            },
        },
    };

    const FONT_FACE: windows::core::PCWSTR = w!("Bahnschrift");

    struct DeviceContext(HDC);

    impl Drop for DeviceContext {
        fn drop(&mut self) {
            unsafe {
                let _ = DeleteDC(self.0);
            }
        }
    }

    struct GdiObject(HGDIOBJ);

    impl Drop for GdiObject {
        fn drop(&mut self) {
            unsafe {
                let _ = DeleteObject(self.0);
            }
        }
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().collect()
    }

    fn create_font(height: i32) -> Option<GdiObject> {
        let font = unsafe {
            CreateFontW(
                -height,
                0,
                0,
                0,
                FW_SEMIBOLD.0 as i32,
                0,
                0,
                0,
                DEFAULT_CHARSET,
                OUT_TT_PRECIS,
                CLIP_DEFAULT_PRECIS,
                CLEARTYPE_QUALITY,
                FF_DONTCARE.0.into(),
                FONT_FACE,
            )
        };
        if font.is_invalid() {
            None
        } else {
            Some(GdiObject(font.into()))
        }
    }

    fn measure(context: HDC, text: &mut [u16]) -> Option<(i32, i32)> {
        let mut bounds = RECT::default();
        let measured = unsafe {
            DrawTextW(
                context,
                text,
                &mut bounds,
                DT_CALCRECT | DT_SINGLELINE | DT_NOCLIP,
            )
        };
        if measured == 0 {
            return None;
        }
        Some((bounds.right - bounds.left, bounds.bottom - bounds.top))
    }

    fn create_surface(context: HDC, size: i32) -> Option<(GdiObject, *mut u8)> {
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: size,
                biHeight: -size,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let bitmap: HBITMAP =
            unsafe { CreateDIBSection(Some(context), &info, DIB_RGB_COLORS, &mut bits, None, 0) }
                .ok()?;
        if bits.is_null() {
            unsafe {
                let _ = DeleteObject(bitmap.into());
            }
            return None;
        }
        Some((GdiObject(bitmap.into()), bits.cast()))
    }

    /// 按实际墨迹边界平移覆盖率图，抵消字体行距造成的视觉偏移。
    fn recenter(coverage: &[u8], size: usize) -> Vec<u8> {
        let mut min_x = size;
        let mut min_y = size;
        let mut max_x = 0usize;
        let mut max_y = 0usize;
        for y in 0..size {
            for x in 0..size {
                if coverage[y * size + x] == 0 {
                    continue;
                }
                min_x = min_x.min(x);
                min_y = min_y.min(y);
                max_x = max_x.max(x);
                max_y = max_y.max(y);
            }
        }
        if min_x > max_x || min_y > max_y {
            return coverage.to_vec();
        }
        let shift_x = (size as i32 - (min_x + max_x + 1) as i32) / 2;
        let shift_y = (size as i32 - (min_y + max_y + 1) as i32) / 2;
        let mut shifted = vec![0u8; coverage.len()];
        for y in 0..size {
            let target_y = y as i32 + shift_y;
            if target_y < 0 || target_y >= size as i32 {
                continue;
            }
            for x in 0..size {
                let target_x = x as i32 + shift_x;
                if target_x < 0 || target_x >= size as i32 {
                    continue;
                }
                shifted[target_y as usize * size + target_x as usize] = coverage[y * size + x];
            }
        }
        shifted
    }

    fn colorize(coverage: &[u8], size: usize, color: [u8; 4]) -> Vec<u8> {
        let mut pixels = vec![0u8; size * size * 4];
        for (index, value) in coverage.iter().enumerate() {
            if *value == 0 {
                continue;
            }
            let offset = index * 4;
            pixels[offset] = color[0];
            pixels[offset + 1] = color[1];
            pixels[offset + 2] = color[2];
            pixels[offset + 3] = (u32::from(*value) * u32::from(color[3]) / 255) as u8;
        }
        pixels
    }

    /// 把文字居中绘制到 size×size 的 RGBA 画布上，返回像素缓冲。
    /// 字号按可用宽高自动收缩，保证长文本不溢出。
    pub fn render_centered(
        size: usize,
        text: &str,
        color: [u8; 4],
        max_width: usize,
        max_height: usize,
    ) -> Option<Vec<u8>> {
        let canvas = size as i32;
        let context = DeviceContext(unsafe { CreateCompatibleDC(None) });
        if context.0.is_invalid() {
            return None;
        }
        let (surface, bits) = create_surface(context.0, canvas)?;
        let previous_bitmap = unsafe { SelectObject(context.0, surface.0) };
        unsafe {
            SetBkMode(context.0, TRANSPARENT);
            // GDI 写入 BGR，先用白色绘制，取灰度作为覆盖率再上色。
            SetTextColor(context.0, windows::Win32::Foundation::COLORREF(0x00ff_ffff));
        }

        let mut buffer = wide(text);
        let mut font_height = max_height as i32;
        let mut placement = None;
        while font_height >= 6 {
            let font = create_font(font_height)?;
            let previous_font = unsafe { SelectObject(context.0, font.0) };
            let measured = measure(context.0, &mut buffer);
            unsafe {
                SelectObject(context.0, previous_font);
            }
            if let Some((width, height)) = measured {
                if width <= max_width as i32 && height <= max_height as i32 {
                    placement = Some((font, width, height));
                    break;
                }
            }
            font_height -= 1;
        }

        let (font, width, height) = placement?;
        let previous_font = unsafe { SelectObject(context.0, font.0) };
        let mut bounds = RECT {
            left: (canvas - width) / 2,
            top: (canvas - height) / 2,
            right: (canvas + width) / 2,
            bottom: (canvas + height) / 2,
        };
        unsafe {
            DrawTextW(
                context.0,
                &mut buffer,
                &mut bounds,
                DT_LEFT | DT_TOP | DT_SINGLELINE | DT_NOCLIP,
            );
            SelectObject(context.0, previous_font);
            SelectObject(context.0, previous_bitmap);
        }

        let count = size * size;
        let source = unsafe { std::slice::from_raw_parts(bits, count * 4) };
        let mut coverage = vec![0u8; count];
        for (index, value) in coverage.iter_mut().enumerate() {
            let offset = index * 4;
            *value = source[offset]
                .max(source[offset + 1])
                .max(source[offset + 2]);
        }
        Some(colorize(&recenter(&coverage, size), size, color))
    }
}

#[cfg(target_os = "windows")]
pub use platform::render_centered;

#[cfg(not(target_os = "windows"))]
pub fn render_centered(
    _size: usize,
    _text: &str,
    _color: [u8; 4],
    _max_width: usize,
    _max_height: usize,
) -> Option<Vec<u8>> {
    None
}
