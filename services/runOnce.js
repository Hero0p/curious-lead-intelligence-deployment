require("dotenv").config();
const { runPipeline } = require("./pipeline");

(async () => {
  try {
    const result = await runPipeline("manual");
    console.log("\nRun summary:", result);
    process.exit(0);
  } catch (err) {
    console.error("\nRun failed:", err.message);
    process.exit(1);
  }
})();
