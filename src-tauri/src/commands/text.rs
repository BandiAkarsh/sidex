use serde::Serialize;
use std::io::Read;

#[derive(Debug, Serialize)]
pub struct FileSummary {
    pub line_count: usize,
    pub word_count: usize,
    pub char_count: usize,
    pub has_bom: bool,
    pub likely_encoding: String,
    pub line_endings: String,
}

#[tauri::command]
pub fn count_lines(path: String) -> Result<usize, String> {
    let mut file = std::fs::File::open(&path).map_err(|e| format!("Failed to open file: {}", e))?;
    let mut buf = [0u8; 32768];
    let mut count = 0usize;

    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("Failed to read: {}", e))?;
        if n == 0 {
            break;
        }
        count += memchr::memchr_iter(b'\n', &buf[..n]).count();
    }

    Ok(count)
}

#[tauri::command]
pub fn file_summary(path: String) -> Result<FileSummary, String> {
    let content = std::fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;

    let has_bom = content.starts_with(&[0xEF, 0xBB, 0xBF]);
    let text_start = if has_bom { 3 } else { 0 };
    let text = String::from_utf8_lossy(&content[text_start..]);

    let mut line_count = 0usize;
    let mut word_count = 0usize;
    let mut char_count = 0usize;
    let mut has_crlf = false;
    let mut has_cr = false;
    let mut in_word = false;

    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        char_count += 1;
        let b = bytes[i];
        match b {
            b'\r' => {
                if i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
                    has_crlf = true;
                    line_count += 1;
                    i += 2;
                } else {
                    has_cr = true;
                    line_count += 1;
                    i += 1;
                }
                in_word = false;
                continue;
            }
            b'\n' => {
                line_count += 1;
                in_word = false;
            }
            b' ' | b'\t' => {
                in_word = false;
            }
            _ if b > 127 => {
                if !in_word {
                    word_count += 1;
                    in_word = true;
                }
            }
            _ => {
                if !in_word && !b.is_ascii_whitespace() {
                    word_count += 1;
                    in_word = true;
                } else if b.is_ascii_whitespace() {
                    in_word = false;
                }
            }
        }
        i += 1;
    }

    if !text.is_empty() && !text.ends_with('\n') && !text.ends_with('\r') {
        line_count += 1;
    }

    let line_endings = if has_crlf {
        "CRLF"
    } else if has_cr {
        "CR"
    } else {
        "LF"
    };

    let likely_encoding = if has_bom {
        "UTF-8 (with BOM)"
    } else if content.is_ascii() {
        "ASCII"
    } else {
        "UTF-8"
    };

    Ok(FileSummary {
        line_count,
        word_count,
        char_count,
        has_bom,
        likely_encoding: likely_encoding.to_string(),
        line_endings: line_endings.to_string(),
    })
}

#[tauri::command]
pub fn normalize_line_endings(text: String) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

#[tauri::command]
pub fn to_crlf(text: String) -> String {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    normalized.replace('\n', "\r\n")
}

#[tauri::command]
pub fn trim_trailing_whitespace(text: String) -> String {
    let mut result = String::with_capacity(text.len());
    for (i, line) in text.lines().enumerate() {
        if i > 0 {
            result.push('\n');
        }
        result.push_str(line.trim_end());
    }
    result
}

#[tauri::command]
pub fn ensure_final_newline(mut text: String) -> String {
    if text.is_empty() || text.ends_with('\n') {
        return text;
    }
    text.push('\n');
    text
}

#[derive(Debug, Serialize)]
pub struct WordBoundary {
    pub start: usize,
    pub end: usize,
}

#[tauri::command]
pub fn get_word_boundaries(line: String, column: usize) -> Result<WordBoundary, String> {
    let bytes = line.as_bytes();
    if bytes.is_empty() || column >= bytes.len() {
        return Ok(WordBoundary { start: 0, end: 0 });
    }

    let is_word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';

    let mut start = column;
    while start > 0 && is_word(bytes[start - 1]) {
        start -= 1;
    }

    let mut end = column;
    while end < bytes.len() && is_word(bytes[end]) {
        end += 1;
    }

    if start == column && end == column {
        start = column.saturating_sub(1);
        end = (column + 1).min(bytes.len());
    }

    Ok(WordBoundary { start, end })
}

#[derive(Debug, Serialize)]
pub struct DiffLine {
    pub line_number: usize,
    pub change_type: &'static str,
    pub content: String,
}

#[tauri::command]
pub fn simple_diff(old_text: String, new_text: String) -> Vec<DiffLine> {
    let old_lines: Vec<&str> = old_text.lines().collect();
    let new_lines: Vec<&str> = new_text.lines().collect();
    let max_lines = old_lines.len().max(new_lines.len());

    let mut result = Vec::new();
    for i in 0..max_lines {
        match (old_lines.get(i), new_lines.get(i)) {
            (Some(old), Some(new)) if old != new => {
                result.push(DiffLine {
                    line_number: i + 1,
                    change_type: "modified",
                    content: new.to_string(),
                });
            }
            (None, Some(new)) => {
                result.push(DiffLine {
                    line_number: i + 1,
                    change_type: "added",
                    content: new.to_string(),
                });
            }
            (Some(_), None) => {
                result.push(DiffLine {
                    line_number: i + 1,
                    change_type: "removed",
                    content: String::new(),
                });
            }
            _ => {}
        }
    }
    result
}

#[tauri::command]
pub fn file_hash(path: String) -> Result<String, String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let content = std::fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;
    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    Ok(format!("{:x}", hasher.finish()))
}

#[tauri::command]
pub fn files_equal(path1: String, path2: String) -> Result<bool, String> {
    let meta1 = std::fs::metadata(&path1).map_err(|e| format!("Failed to stat file 1: {}", e))?;
    let meta2 = std::fs::metadata(&path2).map_err(|e| format!("Failed to stat file 2: {}", e))?;

    if meta1.len() != meta2.len() {
        return Ok(false);
    }

    let mut f1 =
        std::fs::File::open(&path1).map_err(|e| format!("Failed to open file 1: {}", e))?;
    let mut f2 =
        std::fs::File::open(&path2).map_err(|e| format!("Failed to open file 2: {}", e))?;
    let mut buf1 = [0u8; 32768];
    let mut buf2 = [0u8; 32768];

    loop {
        let n1 = f1
            .read(&mut buf1)
            .map_err(|e| format!("Read error: {}", e))?;
        let n2 = f2
            .read(&mut buf2)
            .map_err(|e| format!("Read error: {}", e))?;
        if n1 != n2 || buf1[..n1] != buf2[..n2] {
            return Ok(false);
        }
        if n1 == 0 {
            return Ok(true);
        }
    }
}
