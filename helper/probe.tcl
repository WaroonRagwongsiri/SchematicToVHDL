# Schematic Studio — is a JTAG cable with the board's FPGA on it reachable?
# Prints one line:  S2V_PROBE <n_targets> <device names...>
open_hw_manager
set devs {}
set n 0
if {![catch {connect_hw_server -allow_non_jtag}]} {
	set targets [get_hw_targets -quiet]
	set n [llength $targets]
	foreach t $targets {
		if {[catch {current_hw_target $t; open_hw_target}]} continue
		foreach d [get_hw_devices -quiet] { lappend devs $d }
		catch {close_hw_target}
	}
	catch {disconnect_hw_server}
}
catch {close_hw_manager}
puts "S2V_PROBE $n $devs"
