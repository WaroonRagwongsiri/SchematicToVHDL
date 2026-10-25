// @ts-check
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
	testDir: "tests",
	fullyParallel: true,
	reporter: "list",
	use: {
		trace: "retain-on-failure",
	},
});
