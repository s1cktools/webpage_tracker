const raw = [
  ["weYRabKPSdYQMj_U_BBEVQ", "BSCDaily", "BSCDaily", 2],
  ["dxCeCLOM7uOFJKX8EnS3Kw", "CZ", "CZ", 2],
  ["Pe6pcd-g7GIyvN4zAxXFZA", "heyi", "Yi He", 2],
  ["PaD_UY7mZ3_zFOa2aLM-Zw", "BinanceCN", "币安中文社区", 2],
  ["Vpo7Qwqy63rk7_Km3zYYaQ", "binancezh", "币安Binance华语", 2],
  ["p6Xne418klXDxtDdSOS3HQ", "BinanceWallet", "Binance Wallet", 2],
  ["prX4wIzJqUbHZrMdZlyQzg", "BinanceSquareCN", "币安广场", 2],
  ["5gosYLZ-xcSJmzoOAb04-A", "richardteng", "Richard Teng", 2],
  ["RF5v7JH_6MiIJr-91F-aBA", "Binance_News", "Binance News", 2],
  ["Ed3CFIa4w_Vdxd6lJnhGBg", "Binance_Angels", "Binance Angels", 2],
  ["mxHnTRJyY_8-3Xdba0QhwA", "Binance_Blog", "Binance Blog", 2],
  ["ps1Rw5chtUtfUhsuJ1XDFQ", "Binance_Announcement", "Binance Announcement", 2],
];

const DEFAULT_BINANCE_SQUARE_TARGETS = raw.map(
  ([squareUid, username, displayName, pollIntervalSeconds]) => ({
    squareUid,
    username,
    displayName,
    pollIntervalSeconds: pollIntervalSeconds ?? 2,
  })
);

module.exports = { DEFAULT_BINANCE_SQUARE_TARGETS };
