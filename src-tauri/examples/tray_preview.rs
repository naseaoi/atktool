fn main() {
    let mut all = Vec::new();
    for text in ["90", "F", "5", "--", "8"] {
        let pixels =
            atktool_lib::render_tray_text(32, text, [255, 255, 255, 255], 26, 24).expect("render");
        all.extend_from_slice(&pixels);
    }
    std::fs::write("../tray-samples.raw", all).expect("write");
    println!("written");
}
