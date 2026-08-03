"use strict";

/*
Move:

- collectReachable()
- generateAllVhdl()
- generateSchVhdl()
- formatComponentDecl()
- bundleAll()
- generateVHDL()
- showVhdlFor()
- vhdlHighlight()
- exportVhdlFile()
- exportAllVhdl()

And:

let _lastAllVhdl = null;
*/

$("#vhdlEntitySel")?.addEventListener("change", event => {
	showVhdlFor(event.target.value);
});
