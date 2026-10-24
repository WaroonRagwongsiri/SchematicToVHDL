## SchematicToVHDL
> website สำหรับต่อ schematic ใช้สำหรับวิชา 01076113 Digital Ststem Fundamentals in Practice

## ลงบอร์ด EDGE Spartan-7 (xc7s15ftgb196-1)

1. **Pins** (แผงขวา): กด ⚡ Auto-map หรือเลือกขาเองทีละพอร์ต (sw, led, pb, clk, 7-segment, …) แล้วกด `.xdc` ได้เลยถ้าจะใช้ Vivado เอง
2. รัน helper ครั้งเดียวต่อเครื่อง (ต้องมี Vivado 2025.2 ที่ `~/Vivado/2025.2`, หรือกำหนด `VIVADO_BIN`):
   ```
   npm run helper        # = node helper/server.js
   ```
   แล้วเปิดลิงก์ `http://127.0.0.1:7357/#token=…` ที่มันพิมพ์ออกมา (หรือเปิด `schematic2vhdl.html` ตรง ๆ แล้ววาง token ตอนที่ถาม)
3. **Build** (แผงขวา): ▶ Build → Program SRAM (หายเมื่อปิดไฟ) หรือ Program Flash (บูตเองทุกครั้งที่เปิดไฟ)

ถ้าไม่ได้รัน helper ปุ่ม Build จะดาวน์โหลด `.zip` (vhd + xdc + build.tcl + program.sh) ให้รัน `sh program.sh build|sram|flash` เอง

**ครั้งแรกบน Linux** ต้องติดตั้ง cable driver ของ Vivado ก่อน ไม่งั้นจะไม่เจอบอร์ด แล้วถอดเสียบสาย USB ใหม่:
```
sudo ~/Vivado/2025.2/Vivado/data/xicom/cable_drivers/lin64/install_script/install_drivers/install_drivers
```

ความถี่ clock ของบอร์ดตั้งไว้ 100 MHz (แก้ได้ในแท็บ Pins) — ยังไม่ได้ยืนยันกับคู่มือบอร์ด

Tests: `npm test` (รวม build จริงด้วย Vivado ~2 นาที ถ้ามี Vivado) · `npm run test:fast` (ข้าม Vivado) · แก้ `helper/*.tcl` แล้วต้อง `npm run sync-tcl`
