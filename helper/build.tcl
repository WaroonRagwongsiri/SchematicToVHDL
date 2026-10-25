# Schematic Studio — synth → bitstream → SPI flash image for the EDGE Spartan-7.
#
# Runs in the CURRENT directory, which must hold the *.vhd files and top.xdc.
# Standalone:   vivado -mode batch -nojournal -nolog -source build.tcl -tclargs <top>
# From helper:  the helper sets ::s2v_top (and cd's to the build dir) then sources
#               this file inside its long-running `vivado -mode tcl` session.
#
# Outputs: top.bit, top.mcs, utilization.rpt, timing.rpt, pins.json

if {[info exists ::s2v_top]} {
	set top $::s2v_top
} elseif {[llength $argv] >= 1} {
	set top [lindex $argv 0]
} else {
	error "usage: vivado -mode batch -source build.tcl -tclargs <top_entity>"
}
set part xc7s15ftgb196-1

# a persistent session keeps the previous build's in-memory design and source list
# around — drop both so this build starts from exactly the files in this directory
catch {close_design}
catch {close_project}

set vhds [glob -nocomplain *.vhd]
if {![llength $vhds]} { error "no .vhd files in [pwd]" }
read_vhdl $vhds
read_xdc top.xdc

synth_design -top $top -part $part
opt_design
place_design
route_design

report_utilization -file utilization.rpt
report_timing_summary -file timing.rpt

# where every top-level port actually landed — the helper and the tests compare
# this with the pin map the page sent, so a constraint that silently missed shows up
set fh [open pins.json w]
set items {}
foreach p [lsort [get_ports]] {
	lappend items "\"$p\": \"[get_property PACKAGE_PIN $p]\""
}
puts $fh "\{[join $items {, }]\}"
close $fh

write_bitstream -force top.bit
write_cfgmem -force -format mcs -size 8 -interface SPIx4 -loadbit "up 0x0 top.bit" top.mcs
puts "S2V_BUILD_OK"
