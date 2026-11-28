//! SHA-1 prefix state for the observed OSS `X-Oss-Hash-Ctx` wire protocol.
//!
//! RustCrypto supplies the compression kernel. Only block-aligned prefixes are
//! exported; a final digest must never be substituted for the unpadded state.
use crate::manager::{err, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use sha1::digest::{block_buffer::EagerBuffer, consts::U64};

#[derive(Clone)]
pub(crate) struct Sha1State {
    words: [u32; 5],
    bytes: u64,
    buffer: EagerBuffer<U64>,
}

impl Sha1State {
    pub(crate) fn new() -> Self {
        Self {
            words: [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0],
            bytes: 0,
            buffer: EagerBuffer::default(),
        }
    }

    pub(crate) fn update(&mut self, input: &[u8]) -> Result<()> {
        self.bytes = self
            .bytes
            .checked_add(input.len() as u64)
            .filter(|n| *n <= u64::MAX / 8)
            .ok_or_else(|| err("INVALID_ARG", "上传文件超过 SHA-1 长度上限"))?;
        self.buffer
            .digest_blocks(input, |blocks| sha1::compress(&mut self.words, blocks));
        Ok(())
    }

    pub(crate) fn finalize_hex(mut self) -> Result<String> {
        let bits = self
            .bytes
            .checked_mul(8)
            .ok_or_else(|| err("INVALID_ARG", "上传文件过大"))?;
        self.buffer.len64_padding_be(bits, |block| {
            sha1::compress(&mut self.words, std::slice::from_ref(block));
        });
        let mut out = String::with_capacity(40);
        for w in self.words {
            use std::fmt::Write;
            let _ = write!(&mut out, "{w:08x}");
        }
        Ok(out)
    }

    pub(crate) fn export_base64(&self) -> Result<String> {
        if self.buffer.get_pos() != 0 {
            return Err(err("CONTENT_MISMATCH", "上传哈希前缀未按 64 字节对齐"));
        }
        #[derive(Serialize)]
        #[allow(non_snake_case)]
        struct Context {
            hash_type: &'static str,
            h0: String,
            h1: String,
            h2: String,
            h3: String,
            h4: String,
            Nl: String,
            Nh: String,
            data: &'static str,
            num: &'static str,
        }
        let bits = self
            .bytes
            .checked_mul(8)
            .ok_or_else(|| err("INVALID_ARG", "上传文件过大"))?;
        let context = Context {
            hash_type: "sha1",
            h0: self.words[0].to_string(),
            h1: self.words[1].to_string(),
            h2: self.words[2].to_string(),
            h3: self.words[3].to_string(),
            h4: self.words[4].to_string(),
            Nl: (bits as u32).to_string(),
            Nh: ((bits >> 32) as u32).to_string(),
            data: "",
            num: "0",
        };
        Ok(STANDARD.encode(
            serde_json::to_vec(&context).map_err(|_| err("LOCAL_IO", "上传哈希状态编码失败"))?,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha1::{Digest, Sha1};

    #[test]
    fn real_compression_matches_standard_digest_across_buffer_boundaries() {
        for size in [0, 1, 55, 56, 63, 64, 65, 127, 128, 4097, 65536 + 7] {
            let bytes: Vec<_> = (0..size).map(|i| ((i * 71 + i / 17) % 256) as u8).collect();
            for chunk in [1, 13, 64, 1024] {
                let mut state = Sha1State::new();
                for data in bytes.chunks(chunk) {
                    state.update(data).unwrap();
                }
                assert_eq!(
                    state.finalize_hex().unwrap(),
                    format!("{:x}", Sha1::digest(&bytes)),
                    "size={size} chunk={chunk}"
                );
            }
        }
    }

    #[test]
    fn exports_real_unpadded_prefix_and_bit_counter_high_word() {
        let mut state = Sha1State::new();
        state.update(&[b'a'; 64]).unwrap();
        let context: serde_json::Value =
            serde_json::from_slice(&STANDARD.decode(state.export_base64().unwrap()).unwrap())
                .unwrap();
        assert_eq!(context["h0"], "3662244075"); // Independently recorded evaluation fixture, before padding.
        assert_eq!(context["Nl"], "512");
        assert_eq!(context["Nh"], "0");
        state.bytes = 512 * 1024 * 1024 + 64;
        let context: serde_json::Value =
            serde_json::from_slice(&STANDARD.decode(state.export_base64().unwrap()).unwrap())
                .unwrap();
        assert_eq!(context["Nl"], "512");
        assert_eq!(context["Nh"], "1");
        state.update(&[1]).unwrap();
        assert!(state.export_base64().is_err());
    }
}
