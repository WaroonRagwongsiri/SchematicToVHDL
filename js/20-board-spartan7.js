"use strict";

/* =========================================================================
   BOARD: EDGE Spartan-7 (xc7s15ftgb196-1, 8 MB s25fl064l SPI flash)
   ========================================================================= */
/* Transcribed by hand from DigitalLab/spartan7.xdc rather than parsed at runtime:
   that file has lines a parser trips over ({pin8}}], {pin13]}]) and reuses names
   (SCK/CS appear for both the SPI ADC and the SPI DAC). Here the SPI pins are
   adc_* / dac_*, and J5's pin5..pin20 are one vector j5[0..15] (j5[i] = pin i+5)
   so a bus can land on the header in one go.
   dir: what the PCB wires the pin to — "in" (switch, button, clock), "out"
   (LED, display) or "io" (a connector: either is fine). Mapping an OUT port onto
   a switch would fight the switch, so the pin panel warns about it. */
const _bits = pins => pins.map((pin, i) => ({ i, pin }));
const BOARD_S7 = {
	name: "EDGE Spartan-7",
	part: "xc7s15ftgb196-1",
	flash: { part: "s25fl064l-spi-x1_x2_x4", sizeMB: 8, iface: "SPIx4" },
	clockSig: "clk",
	// the board manual gives no oscillator figure we could confirm; 100 MHz is the
	// tighter guess (a period shorter than the real one only makes timing stricter)
	defaultClockMHz: 100,
	signals: [
		{ group: "Clock", name: "clk", dir: "in", pin: "H11" },
		{ group: "Switches", name: "sw", dir: "in", bits: _bits(["K11", "M11", "N14", "P12", "N10", "P10", "M10", "N4", "L2", "P3", "N1", "M2", "L1", "J3", "K3", "J1"]) },
		{ group: "LEDs", name: "led", dir: "out", bits: _bits(["K12", "M12", "M14", "P13", "N11", "P11", "L5", "M4", "J4", "L3", "P4", "K4", "P2", "J2", "M3", "M1"]) },
		// 0 top, 1 bottom, 2 left, 3 right, 4 center — no pull-up on the board, so pulldown
		{ group: "Push Buttons", name: "pb", dir: "in", pulldown: true, bits: _bits(["J13", "L13", "J14", "J11", "J12"]) },
		// digit[0] is the rightmost digit
		{ group: "7-Segment", name: "digit", dir: "out", bits: _bits(["H4", "H3", "H2", "H1"]) },
		// Seven_Segment[7..0] = A B C D E F G DP
		{ group: "7-Segment", name: "seven_segment", dir: "out", bits: _bits(["J2", "K4", "J4", "M1", "M3", "P2", "P4", "L3"]) },
		{ group: "LCD 2x16", name: "data", dir: "out", bits: _bits(["M4", "L5", "P11", "N11", "P13", "M14", "M12", "K12"]) },
		{ group: "LCD 2x16", name: "lcd_e", dir: "out", pin: "P5" },
		{ group: "LCD 2x16", name: "lcd_rs", dir: "out", pin: "M5" },
		{ group: "TFT 1.8\"", name: "tft_sck", dir: "out", pin: "N11" },
		{ group: "TFT 1.8\"", name: "tft_sdi", dir: "out", pin: "P13" },
		{ group: "TFT 1.8\"", name: "tft_dc", dir: "out", pin: "M14" },
		{ group: "TFT 1.8\"", name: "tft_reset", dir: "out", pin: "M12" },
		{ group: "TFT 1.8\"", name: "tft_cs", dir: "out", pin: "K12" },
		{ group: "Buzzer", name: "buzzer", dir: "out", pin: "B14" },
		{ group: "SPI ADC", name: "adc_sck", dir: "out", pin: "D1" },
		{ group: "SPI ADC", name: "adc_cs", dir: "out", pin: "F4" },
		{ group: "SPI ADC", name: "adc_din", dir: "out", pin: "G4" },
		{ group: "SPI ADC", name: "adc_dout", dir: "in", pin: "C1" },
		{ group: "SPI DAC", name: "dac_sck", dir: "out", pin: "F1" },
		{ group: "SPI DAC", name: "dac_cs", dir: "out", pin: "D2" },
		{ group: "SPI DAC", name: "dac_mosi", dir: "out", pin: "E2" },
		{ group: "USB UART", name: "usb_uart_txd", dir: "io", pin: "F2" },
		{ group: "USB UART", name: "usb_uart_rxd", dir: "io", pin: "G1" },
		{ group: "WiFi", name: "wifi_txd", dir: "io", pin: "A12" },
		{ group: "WiFi", name: "wifi_rxd", dir: "io", pin: "A10" },
		{ group: "Bluetooth", name: "bluetooth_txd", dir: "io", pin: "F3" },
		{ group: "Bluetooth", name: "bluetooth_rxd", dir: "io", pin: "D4" },
		{ group: "Audio", name: "audio_l", dir: "out", pin: "A13" },
		{ group: "Audio", name: "audio_r", dir: "out", pin: "B13" },
		{ group: "PS/2", name: "ps2_clk", dir: "io", pin: "E11" },
		{ group: "PS/2", name: "ps2_data", dir: "io", pin: "C12" },
		{ group: "VGA", name: "vga_hsync", dir: "out", pin: "C4" },
		{ group: "VGA", name: "vga_vsync", dir: "out", pin: "E4" },
		{ group: "VGA", name: "vga_r", dir: "out", bits: _bits(["B6", "D3", "C3", "A4"]) },
		{ group: "VGA", name: "vga_g", dir: "out", bits: _bits(["A3", "B3", "A2", "B5"]) },
		{ group: "VGA", name: "vga_b", dir: "out", bits: _bits(["A5", "B2", "B1", "C5"]) },
		{ group: "Camera (J5)", name: "ov7670_sioc", dir: "out", pin: "L14" },
		{ group: "Camera (J5)", name: "ov7670_siod", dir: "io", pin: "M13" },
		{ group: "Camera (J5)", name: "ov7670_vsync", dir: "in", pin: "H14" },
		{ group: "Camera (J5)", name: "ov7670_href", dir: "in", pin: "H13" },
		{ group: "Camera (J5)", name: "ov7670_pclk", dir: "in", pin: "F11" },
		{ group: "Camera (J5)", name: "ov7670_xclk", dir: "out", pin: "G11" },
		{ group: "Camera (J5)", name: "ov7670_data", dir: "in", bits: _bits(["D12", "D13", "G14", "F14", "F13", "E13", "D14", "C14"]) },
		{ group: "Camera (J5)", name: "ov7670_reset", dir: "out", pin: "E12" },
		{ group: "Camera (J5)", name: "ov7670_pwdn", dir: "out", pin: "F12" },
		// J5 pin1 5V, pin2 NC, pin3 3V3, pin4 GND — so the header's IO starts at pin5
		{ group: "J5 Header", name: "j5", dir: "io", bits: _bits(["L14", "M13", "H14", "H13", "F11", "G11", "C14", "D14", "E13", "F13", "F14", "G14", "D13", "D12", "E12", "F12"]) },
	],
};

function boardSignal(name) {
	return BOARD_S7.signals.find(s => s.name === name) || null;
}
function boardSigWidth(s) { return s.bits ? s.bits.length : 1; }
/* package pin of bit `i` of a board signal (i ignored for a scalar) */
function boardPin(s, i) { return s.bits ? (s.bits[i] && s.bits[i].pin) : s.pin; }
/* the XDC spelling of one board signal bit, for messages: led[3], clk */
function boardBitName(s, i) { return s.bits ? `${s.name}[${i}]` : s.name; }
