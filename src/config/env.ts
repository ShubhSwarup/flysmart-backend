import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const env = {
  mongodbUri: required("MONGODB_URI"),
  serpApiKey: required("SERPAPI_KEY"),
  duffelApiKey: process.env.DUFFEL_API_KEY ?? "",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID ?? "",
  port: Number(process.env.PORT ?? 3001),
};
