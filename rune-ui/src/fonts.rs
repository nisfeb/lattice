//! The theme's font, read from this computer's own files and handed to
//! Rune at launch, with one fault in a font's own tables put right on
//! the way. Some families ship slanted faces whose tables say "regular"
//! (Berkeley Mono's obliques do). fontconfig tells them apart by the
//! slant angle, so other apps draw the family rightly. Rune's font
//! library goes by the style flags alone, takes the upright and the
//! slanted face for the same face, and may draw everything slanted.

/// Where a table of a font file is: its offset, when the file has it.
fn table(font: &[u8], tag: &[u8; 4]) -> Option<usize> {
    let n = u16::from_be_bytes(font.get(4..6)?.try_into().ok()?) as usize;
    (0..n).find_map(|i| {
        let rec = font.get(12 + 16 * i..28 + 16 * i)?;
        (&rec[..4] == tag).then(|| u32::from_be_bytes(rec[8..12].try_into().expect("four bytes")) as usize)
    })
}

/// Marks a slanted face as slanted, when its tables do not: a face with a
/// slant angle whose style flags say neither italic nor oblique is given
/// the italic flag and loses the regular one. `true` when the file was
/// changed. A collection of faces in one file is left alone.
pub fn mend(font: &mut [u8]) -> bool {
    if font.get(..4) == Some(b"ttcf") {
        return false;
    }
    let (Some(os2), Some(post)) = (table(font, b"OS/2"), table(font, b"post")) else { return false };
    let (Some(angle), Some(flags)) = (font.get(post + 4..post + 8), font.get(os2 + 62..os2 + 64)) else { return false };
    let slanted = angle != [0, 0, 0, 0];
    let flags = u16::from_be_bytes([flags[0], flags[1]]);
    // bit 0 is italic, bit 9 oblique, bit 6 regular
    if !slanted || flags & 0x201 != 0 {
        return false;
    }
    font[os2 + 62..os2 + 64].copy_from_slice(&((flags | 1) & !0x40).to_be_bytes());
    // and the older flag beside it, in the head table
    if let Some(mac) = table(font, b"head").filter(|h| h + 46 <= font.len()).map(|h| h + 44) {
        let was = u16::from_be_bytes([font[mac], font[mac + 1]]);
        font[mac..mac + 2].copy_from_slice(&(was | 2).to_be_bytes());
    }
    true
}

/// The files of a family installed on this computer, as fontconfig lists
/// them, each read and mended. Nothing when there is no fontconfig to
/// ask, or the family is not installed: Rune then looks for it itself.
#[cfg(not(target_arch = "wasm32"))]
pub fn of_family(family: &str) -> Vec<Vec<u8>> {
    // a name with fontconfig's own marks in it is not asked for
    if family.is_empty() || family.contains([':', ',', '-', '\\']) {
        return Vec::new();
    }
    let Ok(out) = std::process::Command::new("fc-list").arg(format!(":family={family}")).arg("file").output() else { return Vec::new() };
    let mut paths: Vec<String> = String::from_utf8_lossy(&out.stdout).lines().filter_map(|l| l.split(": ").next().map(|p| p.trim().trim_end_matches(':').to_owned())).filter(|p| !p.is_empty()).collect();
    paths.sort();
    paths.dedup();
    // a family is a handful of faces: more than that, or a very large file, is not a text family to load whole
    paths.into_iter().take(24).filter_map(|p| std::fs::read(p).ok()).filter(|b| b.len() < 16 << 20).map(|mut b| {
        mend(&mut b);
        b
    }).collect()
}

/// Where the fonts fetched from a ship are kept: beside the app's own
/// files, one for each face, named by its id. A face is the same file on
/// every ship, so they are not kept apart by ship.
#[cfg(not(target_arch = "wasm32"))]
pub fn kept_dir() -> Option<std::path::PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME").map(std::path::PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".config")))?;
    Some(base.join("lattice-rune").join("fonts"))
}

/// Whether these bytes are the face of this id: Talon names a font's
/// file by its sha256, and a file that is not its name is not taken.
/// Off Unix there is no hash in the build, and the font's own tables are
/// the only check, as in a browser with no `crypto.subtle`.
pub fn is_face(id: &str, bytes: &[u8]) -> bool {
    if id.len() != 64 || bytes.len() < 12 {
        return false;
    }
    #[cfg(unix)]
    {
        let sum: String = ring::digest::digest(&ring::digest::SHA256, bytes).as_ref().iter().map(|b| format!("{b:02x}")).collect();
        sum == id
    }
    #[cfg(not(unix))]
    {
        id.bytes().all(|b| b.is_ascii_hexdigit())
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn face_path(dir: &std::path::Path, id: &str) -> std::path::PathBuf {
    dir.join(format!("{id}.font"))
}

/// The faces kept in `dir` among these ids, each checked against its
/// id and mended, for Rune at launch.
#[cfg(not(target_arch = "wasm32"))]
pub fn kept_at(dir: &std::path::Path, ids: &[String]) -> Vec<Vec<u8>> {
    ids.iter()
        .filter_map(|id| std::fs::read(face_path(dir, id)).ok().filter(|b| is_face(id, b)))
        .map(|mut b| {
            mend(&mut b);
            b
        })
        .collect()
}

/// The ids among these with no file kept in `dir`.
#[cfg(not(target_arch = "wasm32"))]
pub fn missing_at(dir: &std::path::Path, ids: &[String]) -> Vec<String> {
    ids.iter().filter(|id| !face_path(dir, id).is_file()).cloned().collect()
}

/// Keeps a face fetched from a ship, when it is the file its id says.
#[cfg(not(target_arch = "wasm32"))]
pub fn keep_at(dir: &std::path::Path, id: &str, bytes: &[u8]) -> Result<(), String> {
    if !is_face(id, bytes) {
        return Err("not the file its name says".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let (tmp, to) = (dir.join(format!("{id}.part")), face_path(dir, id));
    std::fs::write(&tmp, bytes).and_then(|()| std::fs::rename(&tmp, &to)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A font file with only the three tables the mending reads, with these flags and this slant.
    fn font(flags: u16, mac: u16, angle: i32) -> Vec<u8> {
        let mut f = vec![0u8; 12 + 3 * 16];
        f[..4].copy_from_slice(b"OTTO");
        f[4..6].copy_from_slice(&3u16.to_be_bytes());
        for (i, (tag, len)) in [(b"OS/2", 96usize), (b"head", 54), (b"post", 32)].into_iter().enumerate() {
            let at = f.len();
            f[12 + 16 * i..16 + 16 * i].copy_from_slice(tag);
            f[20 + 16 * i..24 + 16 * i].copy_from_slice(&(at as u32).to_be_bytes());
            f[24 + 16 * i..28 + 16 * i].copy_from_slice(&(len as u32).to_be_bytes());
            f.resize(at + len, 0);
            match &tag[..] {
                b"OS/2" => f[at + 62..at + 64].copy_from_slice(&flags.to_be_bytes()),
                b"head" => f[at + 44..at + 46].copy_from_slice(&mac.to_be_bytes()),
                _ => f[at + 4..at + 8].copy_from_slice(&angle.to_be_bytes()),
            }
        }
        f
    }

    fn flags(f: &[u8]) -> (u16, u16) {
        let (o, h) = (table(f, b"OS/2").unwrap(), table(f, b"head").unwrap());
        (u16::from_be_bytes([f[o + 62], f[o + 63]]), u16::from_be_bytes([f[h + 44], f[h + 45]]))
    }

    #[test]
    fn a_slanted_face_that_says_regular_is_marked_italic() {
        // as Berkeley Mono's oblique is: regular and "use typo metrics" set, a slant of 16 degrees
        let mut f = font(0b1100_0000, 0, -16 << 16);
        assert!(mend(&mut f));
        assert_eq!(flags(&f), (0b1000_0001, 2), "italic on, regular off, the rest kept");
        assert!(!mend(&mut f), "once");
    }

    #[test]
    fn a_face_that_is_right_is_left_alone() {
        for (fl, angle) in [(0b1100_0000u16, 0), (0b1010_0000, 0), (0b1000_0001, -12 << 16), (0b10_1000_0000, -12 << 16)] {
            let mut f = font(fl, 0, angle);
            let was = f.clone();
            assert!(!mend(&mut f) && f == was, "{fl:b} {angle}");
        }
        // a collection of faces, and what is no font at all
        let mut ttc = font(0b1100_0000, 0, -16 << 16);
        ttc[..4].copy_from_slice(b"ttcf");
        assert!(!mend(&mut ttc));
        assert!(!mend(&mut [0u8; 3]) && !mend(&mut []));
        let mut short = font(0b1100_0000, 0, -16 << 16);
        short.truncate(70);
        assert!(!mend(&mut short), "a file cut short is not read past its end");
    }

    #[cfg(unix)]
    #[test]
    fn a_fetched_face_is_kept_only_when_it_is_its_name() {
        let dir = std::env::temp_dir().join(format!("lattice-rune-fonts-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let bytes = font(0x40, 0, 0);
        let id: String = ring::digest::digest(&ring::digest::SHA256, &bytes).as_ref().iter().map(|b| format!("{b:02x}")).collect();
        let other = "0".repeat(64);
        assert_eq!(missing_at(&dir, &[id.clone(), other.clone()]), [id.clone(), other.clone()]);
        assert!(keep_at(&dir, &other, &bytes).is_err(), "bytes under another name are refused");
        keep_at(&dir, &id, &bytes).unwrap();
        assert_eq!(missing_at(&dir, &[id.clone(), other.clone()]), [other.clone()]);
        assert_eq!(kept_at(&dir, &[id.clone(), other.clone()]), [bytes.clone()]);
        // a kept file changed on disk is not handed to Rune
        std::fs::write(dir.join(format!("{id}.font")), b"something else entirely").unwrap();
        assert!(kept_at(&dir, &[id]).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
