//! Validated WASAPI mix formats. Decode bytes explicitly, then reuse the shared mono mixer.

use super::{audio, VoiceError};

const PCM_SUBTYPE: [u8; 16] = [1, 0, 0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113];
const FLOAT_SUBTYPE: [u8; 16] = [3, 0, 0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113];

fn unsupported() -> VoiceError {
    VoiceError::Failed("The microphone's audio format is not supported.".into())
}

pub(super) struct Format {
    pub rate: u32,
    pub align: usize,
    channels: usize,
    bytes: usize,
    valid: u16,
    float: bool,
}

impl Format {
    pub fn parse(b: &[u8]) -> Result<Self, VoiceError> {
        if b.len() < 18 { return Err(unsupported()); }
        let word = |i| u16::from_le_bytes([b[i], b[i + 1]]);
        let dword = |i| u32::from_le_bytes(b[i..i + 4].try_into().unwrap());
        let (tag, channels, rate, align, bits, extra) = (word(0), word(2), dword(4), word(12), word(14), word(16));
        if b.len() != 18 + usize::from(extra) || channels == 0 || rate == 0 || ![8, 16, 24, 32].contains(&bits) {
            return Err(unsupported());
        }
        let (float, valid) = match tag {
            1 | 3 if extra == 0 => (tag == 3, bits),
            0xfffe if extra >= 22 => {
                let float = if b[24..40] == FLOAT_SUBTYPE { true }
                    else if b[24..40] == PCM_SUBTYPE { false }
                    else { return Err(unsupported()); };
                (float, word(18))
            }
            _ => return Err(unsupported()),
        };
        if valid == 0 || valid > bits || (float && (bits != 32 || valid != 32))
            || u32::from(align) != u32::from(channels) * u32::from(bits / 8)
            || rate.checked_mul(u32::from(align)) != Some(dword(8)) {
            return Err(unsupported());
        }
        Ok(Self { rate, align: usize::from(align), channels: usize::from(channels), bytes: usize::from(bits / 8), valid, float })
    }

    /// None is AUDCLNT_BUFFERFLAGS_SILENT: the packet pointer may be NULL.
    pub fn decode(&self, data: Option<&[u8]>, frames: usize) -> Result<Vec<f32>, VoiceError> {
        let size = frames.checked_mul(self.align).ok_or_else(unsupported)?;
        let Some(data) = data else { return Ok(vec![0.0; frames]); };
        if data.len() != size { return Err(unsupported()); }
        let mut channels = vec![Vec::with_capacity(frames); self.channels];
        for frame in data.chunks_exact(self.align) {
            for (channel, bytes) in channels.iter_mut().zip(frame.chunks_exact(self.bytes)) {
                let sample = if self.float {
                    let value = f32::from_le_bytes(bytes.try_into().unwrap());
                    if !value.is_finite() { return Err(unsupported()); }
                    value
                } else {
                    let shift = self.bytes * 8 - usize::from(self.valid);
                    let signed = match self.bytes {
                        1 => i32::from(bytes[0]) - 128,
                        2 => i32::from(i16::from_le_bytes(bytes.try_into().unwrap())),
                        3 => i32::from_le_bytes([0, bytes[0], bytes[1], bytes[2]]) >> 8,
                        4 => i32::from_le_bytes(bytes.try_into().unwrap()),
                        _ => unreachable!(),
                    };
                    (signed >> shift) as f32 / (1u64 << (self.valid - 1)) as f32
                };
                channel.push(sample);
            }
        }
        Ok(audio::mono(&channels.iter().map(Vec::as_slice).collect::<Vec<_>>()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wave(tag: u16, bits: u16, channels: u16) -> Vec<u8> {
        let mut b = vec![0; 18];
        b[0..2].copy_from_slice(&tag.to_le_bytes());
        b[2..4].copy_from_slice(&channels.to_le_bytes());
        b[4..8].copy_from_slice(&48_000u32.to_le_bytes());
        let align = channels * (bits / 8);
        b[8..12].copy_from_slice(&(48_000u32 * u32::from(align)).to_le_bytes());
        b[12..14].copy_from_slice(&align.to_le_bytes());
        b[14..16].copy_from_slice(&bits.to_le_bytes());
        b
    }

    #[test]
    fn float_and_pcm_boundaries_decode_without_reinterpreting_bytes() {
        for (bits, bytes, expected) in [
            (8, vec![0, 128, 255], vec![-1.0, 0.0, 127.0 / 128.0]),
            (16, vec![0, 128, 0, 0, 255, 127], vec![-1.0, 0.0, 32767.0 / 32768.0]),
            (24, vec![0, 0, 128, 0, 0, 0, 255, 255, 127], vec![-1.0, 0.0, 8388607.0 / 8388608.0]),
            (32, vec![0, 0, 0, 128, 0, 0, 0, 0, 255, 255, 255, 127], vec![-1.0, 0.0, 1.0]),
        ] {
            assert_eq!(Format::parse(&wave(1, bits, 1)).unwrap().decode(Some(&bytes), 3).unwrap(), expected);
        }
        let format = Format::parse(&wave(3, 32, 2)).unwrap();
        let bytes: Vec<u8> = [1.0f32, -0.5, 0.25, 0.75].into_iter().flat_map(f32::to_le_bytes).collect();
        assert_eq!(format.decode(Some(&bytes), 2).unwrap(), vec![0.25, 0.5]);
        assert_eq!(format.decode(None, 2).unwrap(), vec![0.0; 2], "silent packets need no buffer");
        assert!(format.decode(Some(&bytes[..15]), 2).is_err());
        let mono = Format::parse(&wave(3, 32, 1)).unwrap();
        assert!(mono.decode(Some(&f32::NAN.to_le_bytes()), 1).is_err());
        assert!(mono.decode(Some(&f32::INFINITY.to_le_bytes()), 1).is_err());
        assert_eq!(mono.decode(Some(&[]), 0).unwrap(), Vec::<f32>::new());
        assert!(mono.decode(None, usize::MAX).is_err());
    }

    #[test]
    fn extensible_valid_bits_and_subtype_are_checked() {
        let mut bytes = wave(0xfffe, 32, 1);
        bytes.resize(40, 0);
        bytes[16..18].copy_from_slice(&22u16.to_le_bytes());
        bytes[18..20].copy_from_slice(&24u16.to_le_bytes());
        bytes[24..40].copy_from_slice(&PCM_SUBTYPE);
        let f = Format::parse(&bytes).unwrap();
        assert_eq!(f.decode(Some(&[0, 0, 0, 128]), 1).unwrap(), vec![-1.0]);
        bytes[18..20].copy_from_slice(&0u16.to_le_bytes());
        assert!(Format::parse(&bytes).is_err());
        bytes[18..20].copy_from_slice(&33u16.to_le_bytes());
        assert!(Format::parse(&bytes).is_err());
        bytes[18..20].copy_from_slice(&32u16.to_le_bytes());
        bytes[24] = 3;
        assert!(Format::parse(&bytes).is_ok());
        bytes[25] = 1;
        assert!(Format::parse(&bytes).is_err(), "the entire GUID must match");
        assert!(Format::parse(&bytes[..39]).is_err());
    }

    #[test]
    fn malformed_or_unsupported_metadata_is_rejected() {
        assert!(Format::parse(&[]).is_err());
        for (offset, value) in [(0, 2), (2, 0), (4, 0), (12, 1), (14, 12), (16, 1)] {
            let mut bytes = wave(1, 16, 1);
            bytes[offset] = value;
            if offset == 4 { bytes[4..8].fill(0); }
            assert!(Format::parse(&bytes).is_err(), "offset {offset}");
        }
        assert!(Format::parse(&wave(3, 64, 1)).is_err());
        let mut bytes = wave(1, 16, 1);
        bytes[8] ^= 1;
        assert!(Format::parse(&bytes).is_err(), "average bytes must agree");
    }
}
