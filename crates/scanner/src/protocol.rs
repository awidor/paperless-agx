//! The scan protocol of Samsung (and Xerox) laser MFPs on TCP port 9400, as spoken by SANE's
//! `xerox_mfp` backend: INQUIRY, RESERVE_UNIT, SET_WINDOW, then per page OBJECT_POSITION and
//! READ / READ_IMAGE until the last block, then RELEASE_UNIT.
//!
//! Only color JPEG transfer is used. The SL-M3870FW then sends each page as 128-line strips,
//! every strip a complete JPEG of exactly the announced length. Its uncompressed transfer over
//! the network is broken in the firmware: it sends a whole buffer before the scan head has
//! filled it (stale memory after the first 128 lines) and restarts the block when asked again.

use std::time::Duration;

use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time::{Instant, sleep, timeout},
};

use crate::ScanError;

const CMD_ABORT: u8 = 0x06;
const CMD_INQUIRY: u8 = 0x12;
const CMD_RESERVE_UNIT: u8 = 0x16;
const CMD_RELEASE_UNIT: u8 = 0x17;
const CMD_SET_WINDOW: u8 = 0x24;
const CMD_READ: u8 = 0x28;
const CMD_READ_IMAGE: u8 = 0x29;
const CMD_OBJECT_POSITION: u8 = 0x31;

const RES_CODE: u8 = 0xa8;
const STATUS_CHECK: u8 = 0x02;
const STATUS_CANCEL: u8 = 0x04;
const STATUS_BUSY: u8 = 0x08;
const MSG_PRODUCT_INFO: u8 = 0x10;
const MSG_SCANNING_PARAM: u8 = 0x30;
const MSG_END_BLOCK: u8 = 0x81;

// Scanner state bits, reported with STATUS_CHECK.
const STATE_NO_DOCUMENT: u16 = 0x010;
const STATE_DOCUMENT_JAM: u16 = 0x020;
const STATE_COVER_OPEN: u16 = 0x040;
const STATE_WARMING: u16 = 0x080;
const STATE_LOCKING: u16 = 0x100;
const STATE_INVALID_AREA: u16 = 0x200;
const STATE_RESOURCE_BUSY: u16 = 0x400;

pub(crate) const SOURCE_DUPLEX: u8 = 0x10;
pub(crate) const SOURCE_FEEDER: u8 = 0x20;
pub(crate) const SOURCE_GLASS: u8 = 0x40;
const COMPOSITION_RGB: u8 = 0x05;
const COMPRESSION_JPEG: u8 = 0x06;

pub(crate) const INQUIRY_LEN: usize = 70;
pub(crate) const REPLY_LEN: usize = 32;
/// SET_WINDOW declares 0x13 bytes of parameters but the firmware expects 25 bytes in all.
const SET_WINDOW_LEN: usize = 25;

/// Ordinary replies come at once; a scanner still finishing an aborted scan may not answer at all.
const REPLY_TIMEOUT: Duration = Duration::from_secs(15);
const IMAGE_TIMEOUT: Duration = Duration::from_secs(60);
/// Waking from sleep and warming the lamp can keep the scanner busy for a while.
const BUSY_DEADLINE: Duration = Duration::from_secs(90);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_STRIP_LEN: usize = 64 << 20;

/// The resolutions this protocol can ask for, with their codes in SET_WINDOW.
const DPI_CODES: [(u16, u8); 6] = [(75, 0), (100, 10), (150, 2), (200, 9), (300, 5), (600, 7)];
/// The resolution bits of the INQUIRY reply.
const INQUIRY_DPI_BITS: [u16; 13] = [75, 150, 0, 0, 200, 300, 0, 0, 600, 0, 0, 1200, 100];

pub(crate) fn dpi_code(dpi: u16) -> Option<u8> {
    DPI_CODES
        .iter()
        .find(|(value, _)| *value == dpi)
        .map(|(_, code)| *code)
}

/// What the scanner reports about itself. Lengths are in 1/1200 inch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScannerInfo {
    pub model: String,
    pub resolutions: Vec<u16>,
    pub has_feeder: bool,
    pub has_duplex: bool,
    pub feeder_loaded: bool,
    pub max_width: u32,
    pub max_length_glass: u32,
    pub max_length_feeder: u32,
    pub jpeg: bool,
}

impl ScannerInfo {
    pub(crate) fn parse(reply: &[u8]) -> Result<Self, ScanError> {
        if reply.len() < INQUIRY_LEN || reply[3] != MSG_PRODUCT_INFO {
            return Err(ScanError::Protocol("unexpected INQUIRY reply".into()));
        }
        let be32 = |offset: usize| {
            u32::from_be_bytes(reply[offset..offset + 4].try_into().expect("four bytes"))
        };
        let bits =
            u32::from(reply[0x37]) << 16 | u32::from(reply[0x24]) << 8 | u32::from(reply[0x25]);
        let has_duplex = reply[0x26] & 0x18 != 0;
        let has_feeder = (reply[0x26] & 0x03 != 0) || has_duplex;
        let mut resolutions: Vec<u16> = INQUIRY_DPI_BITS
            .iter()
            .enumerate()
            .filter(|(bit, dpi)| **dpi != 0 && bits >> bit & 1 == 1 && dpi_code(**dpi).is_some())
            .map(|(_, dpi)| *dpi)
            .collect();
        resolutions.sort_unstable();
        Ok(Self {
            model: String::from_utf8_lossy(&reply[4..0x24]).trim().to_owned(),
            resolutions,
            has_feeder,
            has_duplex,
            feeder_loaded: has_feeder && reply[0x35] == 0x02,
            max_width: be32(0x28),
            max_length_glass: be32(0x3c),
            max_length_feeder: be32(0x38),
            jpeg: reply[0x32] & 0x40 != 0,
        })
    }
}

/// The scan area and settings sent with SET_WINDOW. Sizes are in 1/1200 inch.
pub(crate) struct Window {
    pub width: u32,
    pub length: u32,
    pub dpi_code: u8,
    pub source: u8,
}

impl Window {
    fn parameters(&self) -> [u8; 20] {
        let mut body = [0_u8; 20];
        body[0] = MSG_SCANNING_PARAM;
        body[1..5].copy_from_slice(&self.width.to_be_bytes());
        body[5..9].copy_from_slice(&self.length.to_be_bytes());
        body[9] = self.dpi_code;
        body[10] = self.dpi_code;
        // 11..15: x and y offset in inches and hundredths, both zero.
        body[15] = COMPOSITION_RGB;
        body[16] = COMPRESSION_JPEG;
        body[18] = 2; // line-art threshold (50 %); unused for color
        body[19] = self.source;
        body
    }
}

enum Status {
    Ready,
    Busy,
}

pub(crate) struct Connection {
    stream: TcpStream,
    pub reserved: bool,
}

impl Connection {
    pub async fn open(address: &str) -> Result<Self, ScanError> {
        let unreachable = |reason: String| ScanError::Unreachable {
            address: address.to_owned(),
            reason,
        };
        let stream = timeout(CONNECT_TIMEOUT, TcpStream::connect(address))
            .await
            .map_err(|_| unreachable("no answer".into()))?
            .map_err(|error| unreachable(error.to_string()))?;
        stream.set_nodelay(true).ok();
        Ok(Self {
            stream,
            reserved: false,
        })
    }

    async fn send(&mut self, command: u8, parameters: &[u8]) -> Result<(), ScanError> {
        let mut packet = Vec::with_capacity(SET_WINDOW_LEN);
        let declared = if command == CMD_SET_WINDOW {
            0x13
        } else {
            parameters.len() as u8
        };
        packet.extend_from_slice(&[0x1b, 0xa8, command, declared]);
        packet.extend_from_slice(parameters);
        if command == CMD_SET_WINDOW {
            packet.resize(SET_WINDOW_LEN, 0);
        }
        timeout(REPLY_TIMEOUT, self.stream.write_all(&packet))
            .await
            .map_err(|_| ScanError::NotResponding)?
            .map_err(ScanError::io)
    }

    async fn receive(&mut self, length: usize, limit: Duration) -> Result<Vec<u8>, ScanError> {
        let mut buffer = vec![0; length];
        timeout(limit, self.stream.read_exact(&mut buffer))
            .await
            .map_err(|_| ScanError::NotResponding)?
            .map_err(ScanError::io)?;
        Ok(buffer)
    }

    async fn command(
        &mut self,
        command: u8,
        parameters: &[u8],
        reply_len: usize,
    ) -> Result<Vec<u8>, ScanError> {
        self.send(command, parameters).await?;
        let reply = self.receive(reply_len, REPLY_TIMEOUT).await?;
        if reply[0] != RES_CODE || usize::from(reply[2]) + 3 != reply_len {
            return Err(ScanError::Protocol(format!(
                "bad reply to command {command:#04x}"
            )));
        }
        Ok(reply)
    }

    fn status(command: u8, reply: &[u8]) -> Result<Status, ScanError> {
        match reply[1] {
            STATUS_BUSY => Ok(Status::Busy),
            STATUS_CANCEL => Err(ScanError::CancelledAtPrinter),
            STATUS_CHECK => {
                let at = if command == CMD_READ { 12 } else { 4 };
                let state = u16::from_be_bytes([reply[at], reply[at + 1]]);
                if state & STATE_DOCUMENT_JAM != 0 {
                    Err(ScanError::PaperJam)
                } else if state & STATE_NO_DOCUMENT != 0 {
                    Err(ScanError::NoPaper)
                } else if state & STATE_COVER_OPEN != 0 {
                    Err(ScanError::CoverOpen)
                } else if state & STATE_INVALID_AREA != 0 {
                    Err(ScanError::Protocol(
                        "the scanner rejected the scan area".into(),
                    ))
                } else if state & STATE_LOCKING != 0 {
                    Err(ScanError::Protocol("the scan head is locked".into()))
                } else if state & (STATE_WARMING | STATE_RESOURCE_BUSY) != 0 {
                    Ok(Status::Busy)
                } else if state & !0x001 != 0 {
                    Err(ScanError::Protocol(format!("scanner state {state:#05x}")))
                } else {
                    Ok(Status::Ready)
                }
            }
            _ => Ok(Status::Ready),
        }
    }

    /// Sends a command again, backing off, while the scanner reports it is busy.
    async fn command_wait(&mut self, command: u8) -> Result<Vec<u8>, ScanError> {
        let deadline = Instant::now() + BUSY_DEADLINE;
        let mut pause = Duration::from_millis(10);
        loop {
            let reply = self.command(command, &[], REPLY_LEN).await?;
            match Self::status(command, &reply)? {
                Status::Ready => return Ok(reply),
                Status::Busy if Instant::now() < deadline => {
                    sleep(pause).await;
                    pause = (pause
                        * if pause < Duration::from_millis(100) {
                            10
                        } else {
                            2
                        })
                    .min(Duration::from_secs(1));
                }
                Status::Busy => return Err(ScanError::Busy),
            }
        }
    }

    pub async fn inquiry(&mut self) -> Result<ScannerInfo, ScanError> {
        let reply = self.command(CMD_INQUIRY, &[], INQUIRY_LEN).await?;
        ScannerInfo::parse(&reply)
    }

    pub async fn reserve(&mut self, window: &Window) -> Result<(), ScanError> {
        self.command_wait(CMD_RESERVE_UNIT).await?;
        self.reserved = true;
        let reply = self
            .command(CMD_SET_WINDOW, &window.parameters(), REPLY_LEN)
            .await?;
        // BUSY here is fine: OBJECT_POSITION waits it out (SANE does the same).
        Self::status(CMD_SET_WINDOW, &reply).map(|_| ())
    }

    /// Feeds the next sheet, or readies the glass. Fails with `NoPaper` when the feeder is empty.
    pub async fn next_page(&mut self) -> Result<(), ScanError> {
        self.command_wait(CMD_OBJECT_POSITION).await.map(|_| ())
    }

    /// Reads one block of the page: a JPEG strip, and whether it is the page's last.
    pub async fn read_strip(&mut self) -> Result<(Vec<u8>, bool), ScanError> {
        let reply = self.command_wait(CMD_READ).await?;
        let length = u32::from_be_bytes(reply[4..8].try_into().expect("four bytes")) as usize;
        if length == 0 || length > MAX_STRIP_LEN {
            return Err(ScanError::Protocol(format!(
                "image block of {length} bytes"
            )));
        }
        self.send(CMD_READ_IMAGE, &[]).await?;
        let strip = self.receive(length, IMAGE_TIMEOUT).await?;
        Ok((strip, reply[3] == MSG_END_BLOCK))
    }

    /// Best effort: stop a scan in progress.
    pub async fn abort(&mut self) {
        if let Err(error) = self.command(CMD_ABORT, &[], REPLY_LEN).await {
            tracing::debug!(%error, "scanner abort failed");
        }
    }

    /// Best effort: free the scanner for the printer's own panel and other clients.
    pub async fn release(&mut self) {
        if !self.reserved {
            return;
        }
        self.reserved = false;
        if let Err(error) = self.command(CMD_RELEASE_UNIT, &[], REPLY_LEN).await {
            tracing::debug!(%error, "scanner release failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::inquiry_reply;

    #[test]
    fn parses_the_sl_m3870fw_inquiry() {
        let info = ScannerInfo::parse(&inquiry_reply(false)).unwrap();
        assert_eq!(info.model, "Samsung M337x 387x 407x Series");
        assert_eq!(info.resolutions, vec![75, 100, 150, 200, 300, 600]);
        assert!(info.has_feeder);
        assert!(info.has_duplex);
        assert!(!info.feeder_loaded);
        assert!(
            ScannerInfo::parse(&inquiry_reply(true))
                .unwrap()
                .feeder_loaded
        );
        assert!(info.jpeg);
        assert_eq!(info.max_width, 10_200); // 8.5 in
        assert_eq!(info.max_length_glass, 14_040); // 11.7 in
        assert_eq!(info.max_length_feeder, 16_800); // 14 in
    }

    #[test]
    fn window_asks_for_color_jpeg() {
        let window = Window {
            width: 9_921,
            length: 14_031,
            dpi_code: dpi_code(300).unwrap(),
            source: SOURCE_FEEDER,
        };
        let body = window.parameters();
        assert_eq!(&body[1..5], &9_921_u32.to_be_bytes());
        assert_eq!(&body[5..9], &14_031_u32.to_be_bytes());
        assert_eq!((body[9], body[10]), (5, 5));
        assert_eq!((body[15], body[16], body[19]), (0x05, 0x06, 0x20));
    }
}
