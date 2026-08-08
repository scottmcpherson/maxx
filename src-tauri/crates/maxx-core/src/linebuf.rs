//! Port of `StreamingJSONLineBuffer`: byte-safe accumulation of newline-delimited
//! JSON across arbitrary chunk boundaries, tolerating CRLF and blank lines.

#[derive(Default)]
pub struct StreamingJsonLineBuffer {
    data: Vec<u8>,
}

impl StreamingJsonLineBuffer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn append(&mut self, chunk: &[u8]) -> Vec<Vec<u8>> {
        self.data.extend_from_slice(chunk);
        let mut lines = Vec::new();
        while let Some(newline) = self.data.iter().position(|&b| b == b'\n') {
            let mut line: Vec<u8> = self.data.drain(..=newline).collect();
            line.pop(); // trailing \n
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if !line.is_empty() {
                lines.push(line);
            }
        }
        lines
    }

    pub fn finish(&mut self) -> Option<Vec<u8>> {
        if self.data.is_empty() {
            return None;
        }
        let mut line = std::mem::take(&mut self.data);
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        if line.is_empty() {
            None
        } else {
            Some(line)
        }
    }
}
