## SchematicToVHDL
> website สำหรับต่อ schematic ใช้สำหรับวิชา 01076113 Digital Ststem Fundamentals in Practice

## ลงบอร์ด EDGE Spartan-7 (xc7s15ftgb196-1)

1. **Pins** : เลือกขาเองทีละพอร์ต (sw, led, pb, clk, 7-segment, …)
2. รัน helper ครั้งเดียว (ต้องมี Vivado 2025.2 ที่ `~/Vivado/2025.2`, หรือกำหนด `VIVADO_BIN`):
   ```
   npm run helper        # = node helper/server.js
   ```
   แล้วเปิดลิงก์ `http://127.0.0.1:7357/#token=…`  (หรือเปิด `schematic2vhdl.html` แล้ววาง token ตอน `ตรวจ helper/board`)
3. **Build** Program SRAM หรือ Program Flash

ถ้าไม่ได้รัน helper ปุ่ม Build จะดาวน์โหลด `.zip` (vhd + xdc + build.tcl + program.sh) ให้รัน `sh program.sh build|sram|flash` เอง

**Linux** ต้องติดตั้ง cable driver ของ Vivado ก่อน ไม่งั้นจะไม่เจอบอร์ด แล้วถอดเสียบสาย USB ใหม่:
```
sudo ~/Vivado/2025.2/Vivado/data/xicom/cable_drivers/lin64/install_script/install_drivers/install_drivers
```

ความถี่ clock ของบอร์ด 50 MHz (แก้ได้ในแท็บ Pins) · 7-segment: `seven_segment[0]` = A … `[6]` = G (เหมือน xdc ของแล็บ), จุด DP แยกเป็น `dp`

Tests: `npm test` (รวม build ถ้ามี Vivado) · `npm run test:fast` (ข้าม Vivado) · แก้ `helper/*.tcl` แล้วต้อง `npm run sync-tcl`
