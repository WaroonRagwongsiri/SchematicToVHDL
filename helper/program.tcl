# Schematic Studio — program the EDGE Spartan-7 over JTAG with Vivado's hardware manager.
#
#   sram : load top.bit straight into the FPGA (gone at power-off)
#   flash: write top.mcs into the s25fl064l SPI flash (erase + program + verify),
#          then reboot the FPGA from it — the design survives a power cycle
#
# Standalone:   vivado -mode batch -nojournal -nolog -source program.tcl -tclargs sram|flash
# From helper:  ::s2v_target is set and the build dir is the current directory.

if {[info exists ::s2v_target]} {
	set target $::s2v_target
} elseif {[llength $argv] >= 1} {
	set target [lindex $argv 0]
} else {
	error "usage: vivado -mode batch -source program.tcl -tclargs sram|flash"
}
if {$target ne "sram" && $target ne "flash"} { error "target must be sram or flash, not '$target'" }
set bit [file normalize top.bit]
set mcs [file normalize top.mcs]
set prm [file normalize top.prm]
if {![file exists $bit]} { error "no top.bit in [pwd] — build first" }
if {$target eq "flash" && ![file exists $mcs]} { error "no top.mcs in [pwd] — build first" }

open_hw_manager
connect_hw_server -allow_non_jtag
# whatever happens below, never leave the cable claimed: the next run (or the
# Vivado GUI) could not open the target otherwise
set rc [catch {
	set targets [get_hw_targets -quiet]
	if {![llength $targets]} {
		error "ไม่พบสาย JTAG — เสียบบอร์ดแล้วหรือยัง? (Linux: ติดตั้ง cable driver ของ Vivado แล้วเสียบใหม่)"
	}
	current_hw_target [lindex $targets 0]
	open_hw_target
	set dev [lindex [get_hw_devices -quiet xc7s15*] 0]
	if {$dev eq ""} { error "บนสาย JTAG ไม่พบ xc7s15 (เจอ: [get_hw_devices -quiet])" }
	current_hw_device $dev
	refresh_hw_device -update_hw_probes false $dev

	if {$target eq "sram"} {
		set_property PROGRAM.FILE $bit $dev
		program_hw_devices $dev
	} else {
		create_hw_cfgmem -hw_device $dev [lindex [get_cfgmem_parts {s25fl064l-spi-x1_x2_x4}] 0]
		set cfg [get_property PROGRAM.HW_CFGMEM $dev]
		set_property PROGRAM.ADDRESS_RANGE {use_file} $cfg
		set_property PROGRAM.FILES [list $mcs] $cfg
		set_property PROGRAM.PRM_FILE [expr {[file exists $prm] ? $prm : {}}] $cfg
		set_property PROGRAM.UNUSED_PIN_TERMINATION {pull-none} $cfg
		set_property PROGRAM.BLANK_CHECK 0 $cfg
		set_property PROGRAM.ERASE 1 $cfg
		set_property PROGRAM.CFG_PROGRAM 1 $cfg
		set_property PROGRAM.VERIFY 1 $cfg
		set_property PROGRAM.CHECKSUM 0 $cfg
		# the flash is reached THROUGH the FPGA: load Vivado's small SPI bridge
		# bitstream first, then stream the image into the flash and read it back
		create_hw_bitstream -hw_device $dev [get_property PROGRAM.HW_CFGMEM_BITFILE $dev]
		program_hw_devices $dev
		refresh_hw_device $dev
		program_hw_cfgmem -hw_cfgmem $cfg
		puts "S2V_FLASH_VERIFIED"
		# reboot from the flash we just wrote, as a power cycle would
		boot_hw_device $dev
	}
	refresh_hw_device $dev
	puts "S2V_DONE_PIN [get_property REGISTER.CONFIG_STATUS.BIT14_DONE_PIN $dev]"
} msg]
catch {close_hw_target}
catch {disconnect_hw_server}
catch {close_hw_manager}
if {$rc} { error $msg }
puts "S2V_PROGRAM_OK $target"
