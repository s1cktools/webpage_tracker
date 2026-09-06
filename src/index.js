const pagePulseRole = String(process.env.PAGEPULSE_ROLE || "hub").trim().toLowerCase();
const appRole = String(process.env.APP_ROLE || "primary").trim().toLowerCase();

if (pagePulseRole === "satellite") {
  require("./satellite").startSatelliteProcess();
} else if (pagePulseRole !== "hub") {
  throw new Error(`Unsupported PAGEPULSE_ROLE: ${pagePulseRole}`);
} else if (appRole === "primary") {
  require("./server");
} else if (appRole === "binance-probe") {
  require("./binance-probe").startBinanceProbe();
} else {
  throw new Error(`Unsupported APP_ROLE: ${appRole}`);
}
