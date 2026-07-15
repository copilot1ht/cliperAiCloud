export const providerData = [
  { name: "Google Gemini", code: "gemini", model: "gemini-3.5-flash", status: "Healthy", latency: "1.2 s", keys: 2, success: "99.1%", cost: "$4.82" },
  { name: "DeepSeek", code: "deepseek", model: "deepseek-chat", status: "Healthy", latency: "1.8 s", keys: 3, success: "97.8%", cost: "$2.19" },
];

export const recentUsage = [
  { module: "Highlight Finder", provider: "Gemini", model: "gemini-3.5-flash", tokens: "18,420", latency: "1.3 s", cost: "$0.0184", status: "Success", time: "10:42" },
  { module: "Title Generator", provider: "DeepSeek", model: "deepseek-chat", tokens: "1,206", latency: "1.7 s", cost: "$0.0011", status: "Success", time: "10:41" },
  { module: "Hook Maker", provider: "Gemini", model: "gemini-3.5-flash", tokens: "986", latency: "1.1 s", cost: "$0.0009", status: "Success", time: "10:41" },
  { module: "Caption Cleaner", provider: "DeepSeek", model: "deepseek-chat", tokens: "642", latency: "2.4 s", cost: "$0.0006", status: "Fallback", time: "10:39" },
  { module: "Metadata", provider: "Gemini", model: "gemini-3.5-flash", tokens: "1,840", latency: "1.0 s", cost: "$0.0018", status: "Success", time: "10:38" },
];

export const routingRules = [
  { module: "Highlight Finder", primary: "Gemini", fallback: "DeepSeek", timeout: "45 s", budget: "1,100", mode: "Quality" },
  { module: "Title Generator", primary: "Gemini", fallback: "DeepSeek", timeout: "30 s", budget: "320", mode: "Balanced" },
  { module: "Hook Maker", primary: "Gemini", fallback: "DeepSeek", timeout: "30 s", budget: "220", mode: "Balanced" },
  { module: "Caption Cleaner", primary: "DeepSeek", fallback: "Gemini", timeout: "20 s", budget: "180", mode: "Economy" },
  { module: "Metadata", primary: "DeepSeek", fallback: "Gemini", timeout: "30 s", budget: "420", mode: "Economy" },
];

export const usageBars = [42, 56, 48, 74, 63, 86, 71, 92, 77, 68, 88, 79, 96, 82];
