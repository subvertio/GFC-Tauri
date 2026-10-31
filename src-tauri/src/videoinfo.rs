//! A video's length and picture size from its MP4/MOV header (the `moov` box), reading only
//! a few kilobytes: the app estimates how big GFC's optimised copy of a video over 1 GB will be
//! before uploading it, without loading the video.

use std::io::{Read, Seek, SeekFrom};

#[derive(Debug, PartialEq, serde::Serialize)]
pub struct VideoInfo {
    pub duration: f64,
    pub width: u32,
    pub height: u32,
}

/// A box at `pos` (inside `limit`): (type, content start, end).
fn header<R: Read + Seek>(r: &mut R, pos: u64, limit: u64) -> Option<([u8; 4], u64, u64)> {
    if pos + 8 > limit {
        return None;
    }
    r.seek(SeekFrom::Start(pos)).ok()?;
    let mut h = [0u8; 8];
    r.read_exact(&mut h).ok()?;
    let mut size = u32::from_be_bytes([h[0], h[1], h[2], h[3]]) as u64;
    let kind = [h[4], h[5], h[6], h[7]];
    let mut head = 8;
    if size == 1 {
        let mut big = [0u8; 8];
        r.read_exact(&mut big).ok()?;
        size = u64::from_be_bytes(big);
        head = 16;
    } else if size == 0 {
        size = limit - pos; // to the end
    }
    let end = pos.checked_add(size)?;
    if size < head || end > limit {
        return None;
    }
    Some((kind, pos + head, end))
}

fn find<R: Read + Seek>(r: &mut R, start: u64, end: u64, kind: &[u8; 4]) -> Option<(u64, u64)> {
    let mut pos = start;
    while let Some((k, content, next)) = header(r, pos, end) {
        if &k == kind {
            return Some((content, next));
        }
        pos = next;
    }
    None
}

fn read_n<R: Read + Seek>(r: &mut R, at: u64, n: usize) -> Option<Vec<u8>> {
    r.seek(SeekFrom::Start(at)).ok()?;
    let mut buf = vec![0u8; n];
    r.read_exact(&mut buf).ok()?;
    Some(buf)
}

fn be32(b: &[u8]) -> u64 {
    u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as u64
}
fn be64(b: &[u8]) -> u64 {
    u64::from_be_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]])
}

/// Movie length in seconds from `mvhd`.
fn mvhd<R: Read + Seek>(r: &mut R, at: u64) -> Option<f64> {
    let b = read_n(r, at, 32)?;
    let (scale, duration) = if b[0] == 1 { (be32(&b[20..]), be64(&b[24..])) } else { (be32(&b[12..]), be32(&b[16..])) };
    (scale > 0 && duration > 0).then(|| duration as f64 / scale as f64)
}

/// Picture size from a track's `tkhd` (0 for audio tracks).
fn tkhd<R: Read + Seek>(r: &mut R, at: u64) -> Option<(u32, u32)> {
    let version = read_n(r, at, 1)?[0];
    let fixed = if version == 1 { 4 + 32 } else { 4 + 20 }; // version/flags, then times, id, duration
    let b = read_n(r, at + fixed + 16 + 36, 8)?; // reserved, layer, group, volume; the matrix; width, height
    Some(((be32(&b[0..]) >> 16) as u32, (be32(&b[4..]) >> 16) as u32))
}

/// Length and size of an MP4/MOV video, or None if this isn't one (or it's damaged).
pub fn mp4_info<R: Read + Seek>(r: &mut R, len: u64) -> Option<VideoInfo> {
    let (start, end) = find(r, 0, len, b"moov")?;
    let duration = find(r, start, end, b"mvhd").and_then(|(at, _)| mvhd(r, at))?;
    let mut pos = start;
    while let Some((kind, content, next)) = header(r, pos, end) {
        if &kind == b"trak" {
            if let Some((w, h)) = find(r, content, next, b"tkhd").and_then(|(at, _)| tkhd(r, at)) {
                if w > 0 && h > 0 {
                    return Some(VideoInfo { duration, width: w, height: h });
                }
            }
        }
        pos = next;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn boxed(kind: &[u8; 4], content: &[u8]) -> Vec<u8> {
        let mut v = ((content.len() + 8) as u32).to_be_bytes().to_vec();
        v.extend_from_slice(kind);
        v.extend_from_slice(content);
        v
    }

    fn tkhd_box(w: u32, h: u32) -> Vec<u8> {
        let mut c = vec![0u8; 4 + 20 + 16 + 36];
        c.extend_from_slice(&(w << 16).to_be_bytes());
        c.extend_from_slice(&(h << 16).to_be_bytes());
        boxed(b"tkhd", &c)
    }

    fn movie(moov_last: bool) -> Vec<u8> {
        let mut mvhd = vec![0u8; 12];
        mvhd.extend_from_slice(&1000u32.to_be_bytes()); // timescale
        mvhd.extend_from_slice(&300_000u32.to_be_bytes()); // 300 s
        mvhd.extend_from_slice(&[0u8; 80]);
        let audio = boxed(b"trak", &tkhd_box(0, 0));
        let video = boxed(b"trak", &tkhd_box(1920, 1080));
        let moov = boxed(b"moov", &[boxed(b"mvhd", &mvhd), audio, video].concat());
        let ftyp = boxed(b"ftyp", b"isom0000");
        let mdat = boxed(b"mdat", &[7u8; 5000]);
        if moov_last { [ftyp, mdat, moov].concat() } else { [ftyp, moov, mdat].concat() }
    }

    #[test]
    fn reads_length_and_size_wherever_the_header_is() {
        for moov_last in [false, true] {
            let data = movie(moov_last);
            let info = mp4_info(&mut Cursor::new(&data), data.len() as u64).unwrap();
            assert_eq!(info, VideoInfo { duration: 300.0, width: 1920, height: 1080 });
        }
    }

    #[test]
    fn junk_is_none_not_a_crash() {
        for data in [vec![], vec![0u8; 3], b"not a video at all".to_vec(), vec![0xffu8; 64]] {
            assert!(mp4_info(&mut Cursor::new(&data), data.len() as u64).is_none());
        }
        let mut cut = movie(true);
        cut.truncate(cut.len() - 20); // the header cut short
        assert!(mp4_info(&mut Cursor::new(&cut), cut.len() as u64).is_none());
    }
}
