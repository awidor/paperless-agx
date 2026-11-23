//! A scanner on a local port that speaks the SL-M3870FW's protocol, for tests.
//!
//! Every page comes as `strips_per_page` JPEG strips of one gray shade each (see
//! [`FakeScanner::shade`]), so tests can tell pages and strips apart.

use std::{
    io::Cursor,
    sync::{Arc, Mutex},
};

use image::{Rgb, RgbImage, codecs::jpeg::JpegEncoder};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

/// The INQUIRY reply of the SL-M3870FW, recorded with an empty feeder.
const SL_M3870FW_INQUIRY: &str = "a800431053616d73756e67204d333337782033383778203430377820536572696573202015338e2b000027d8000041a00001510000010000000041a0000036d8331505051900";

/// The recorded INQUIRY reply, with the feeder reported loaded or empty.
pub fn inquiry_reply(feeder_loaded: bool) -> Vec<u8> {
    let mut reply: Vec<u8> = (0..SL_M3870FW_INQUIRY.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&SL_M3870FW_INQUIRY[index..index + 2], 16).unwrap())
        .collect();
    reply[0x35] = if feeder_loaded { 0x02 } else { 0x01 };
    reply
}

#[derive(Debug, Clone)]
pub struct FakeSetup {
    /// Sheets in the feeder; zero means the feeder is empty.
    pub feeder_sheets: usize,
    /// Whether the scanner advertises a duplex feeder (RADF/DADF).
    pub has_duplex: bool,
    /// How many RESERVE_UNIT requests are answered BUSY first.
    pub busy_reserves: usize,
    /// The feeder jams when it reaches this sheet (counting from one).
    pub jam_on_sheet: Option<usize>,
    pub strips_per_page: usize,
    pub strip_width: u32,
    pub strip_lines: u32,
}

impl Default for FakeSetup {
    fn default() -> Self {
        Self {
            feeder_sheets: 0,
            has_duplex: true,
            busy_reserves: 0,
            jam_on_sheet: None,
            strips_per_page: 2,
            strip_width: 64,
            strip_lines: 16,
        }
    }
}

#[derive(Default)]
struct State {
    commands: Vec<u8>,
    window: Option<Vec<u8>>,
    feeder_left: usize,
    sides_left: usize,
    busy_left: usize,
    /// Pages started in this scan (sheets fed, or the glass page).
    pages: usize,
    strip: usize,
    pending: Option<Vec<u8>>,
}

pub struct FakeScanner {
    port: u16,
    state: Arc<Mutex<State>>,
}

impl FakeScanner {
    pub async fn start(setup: FakeSetup) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = Arc::new(Mutex::new(State {
            feeder_left: setup.feeder_sheets,
            busy_left: setup.busy_reserves,
            ..State::default()
        }));
        let shared = state.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let (state, setup) = (shared.clone(), setup.clone());
                tokio::spawn(async move {
                    let _ = serve(stream, state, setup).await;
                });
            }
        });
        Self { port, state }
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// The command bytes received so far, in order.
    pub fn commands(&self) -> Vec<u8> {
        self.state.lock().unwrap().commands.clone()
    }

    /// The 20 SET_WINDOW parameter bytes of the latest scan.
    pub fn window(&self) -> Option<Vec<u8>> {
        self.state.lock().unwrap().window.clone()
    }

    /// The gray level of a strip of a page, both counted from zero.
    pub fn shade(&self, page: usize, strip: usize) -> u8 {
        shade(page, strip)
    }
}

fn shade(page: usize, strip: usize) -> u8 {
    (40 + 60 * page + 25 * strip).min(250) as u8
}

fn reply(status: u8) -> Vec<u8> {
    let mut reply = vec![0_u8; 32];
    reply[0] = 0xa8;
    reply[1] = status;
    reply[2] = 0x1d;
    reply
}

fn check(state: u16) -> Vec<u8> {
    let mut reply = reply(0x02);
    reply[4..6].copy_from_slice(&state.to_be_bytes());
    reply
}

fn strip(width: u32, lines: u32, level: u8) -> Vec<u8> {
    let image = RgbImage::from_pixel(width, lines, Rgb([level; 3]));
    let mut output = Cursor::new(Vec::new());
    image
        .write_with_encoder(JpegEncoder::new_with_quality(&mut output, 95))
        .unwrap();
    output.into_inner()
}

async fn serve(
    mut stream: TcpStream,
    state: Arc<Mutex<State>>,
    setup: FakeSetup,
) -> std::io::Result<()> {
    loop {
        let mut header = [0_u8; 4];
        if stream.read_exact(&mut header).await.is_err() {
            return Ok(());
        }
        assert_eq!(
            &header[..2],
            &[0x1b, 0xa8],
            "every request starts with 1b a8"
        );
        let command = header[2];
        let extra = if command == 0x24 {
            21
        } else {
            usize::from(header[3])
        };
        let mut parameters = vec![0_u8; extra];
        stream.read_exact(&mut parameters).await?;
        let answer = respond(&mut state.lock().unwrap(), &setup, command, &parameters);
        stream.write_all(&answer).await?;
    }
}

fn respond(state: &mut State, setup: &FakeSetup, command: u8, parameters: &[u8]) -> Vec<u8> {
    state.commands.push(command);
    match command {
        0x12 => {
            let mut reply = inquiry_reply(state.feeder_left > 0);
            if !setup.has_duplex {
                reply[0x26] &= !0x18;
            }
            reply
        }
        0x16 if state.busy_left > 0 => {
            state.busy_left -= 1;
            reply(0x08)
        }
        0x16 => {
            state.pages = 0;
            state.strip = 0;
            reply(0)
        }
        0x24 => {
            let window = parameters[..20].to_vec();
            state.sides_left = match window[19] {
                0x10 => state.feeder_left * 2,
                0x20 => state.feeder_left,
                _ => 1,
            };
            state.window = Some(window);
            reply(0)
        }
        0x31 => {
            let source = state.window.as_ref().map(|window| window[19]);
            let feeder = matches!(source, Some(0x10 | 0x20));
            if feeder {
                let sheet = if source == Some(0x10) {
                    state.pages / 2 + 1
                } else {
                    state.pages + 1
                };
                if setup.jam_on_sheet == Some(sheet) {
                    return check(0x020);
                }
                if state.sides_left == 0 {
                    return check(0x010);
                }
                state.sides_left -= 1;
                state.feeder_left = if source == Some(0x10) {
                    state.sides_left.div_ceil(2)
                } else {
                    state.sides_left
                };
            }
            state.pages += 1;
            state.strip = 0;
            reply(0)
        }
        0x28 => {
            let data = strip(
                setup.strip_width,
                setup.strip_lines,
                shade(state.pages - 1, state.strip),
            );
            let last = state.strip + 1 == setup.strips_per_page;
            let mut answer = reply(0);
            answer[3] = if last { 0x81 } else { 0x80 };
            answer[4..8].copy_from_slice(&(data.len() as u32).to_be_bytes());
            answer[8..10].copy_from_slice(&(setup.strip_lines as u16).to_be_bytes());
            answer[10..12].copy_from_slice(&(setup.strip_width as u16).to_be_bytes());
            state.pending = Some(data);
            answer
        }
        0x29 => {
            state.strip += 1;
            state.pending.take().expect("READ before READ_IMAGE")
        }
        0x06 | 0x17 => reply(0),
        other => panic!("unexpected scanner command {other:#04x}"),
    }
}
