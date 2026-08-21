const role = String(process.env.APP_ROLE || "primary").trim().toLowerCase();

if (role === "primary") {
  require("./server");
} else if (role === "binance-probe") {
  require("./binance-probe").startBinanceProbe();
} else {
  throw new Error(`Unsupported APP_ROLE: ${role}`);
}
