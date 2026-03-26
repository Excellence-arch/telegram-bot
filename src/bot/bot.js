const TelegramBot = require('node-telegram-bot-api');
const Contest = require('../models/Contest');
const Submission = require('../models/Submission');
const Score = require('../models/Score');
const { getImageHash } = require('../services/hashService');
const { analyzeImage } = require('../services/aiService');
const { canUseBot } = require('../utils/checkAdmin');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

/**
 * START CONTEST
 */
bot.onText(/\/startcontest (.+)/, async (msg, match) => {
  const allowed = await canUseBot(bot, msg.chat.id, msg.from.id);
  if (!allowed) return;

  const description = match[1];

  await Contest.create({
    name: 'Contest',
    description,
    chatId: msg.chat.id,
  });

  bot.sendMessage(msg.chat.id, '✅ Contest started!');
});

/**
 * HANDLE SUBMISSIONS
 */
bot.on('message', async (msg) => {
  if (!msg.photo && !msg.document) return;

  const contest = await Contest.findOne({
    chatId: msg.chat.id,
    isActive: true,
  });

  if (!contest) return;

  const file = msg.photo ? msg.photo.pop() : msg.document;

  // Duplicate check
  const exists = await Submission.findOne({
    contestId: contest._id,
    fileUniqueId: file.file_unique_id,
  });

  if (exists) return;

  const fileLink = await bot.getFileLink(file.file_id);

  const hash = await getImageHash(fileLink);

  const hashExists = await Submission.findOne({
    contestId: contest._id,
    imageHash: hash,
  });

  if (hashExists) return;

  // AI
  const ai = await analyzeImage(fileLink, contest.description);

  if (ai.verdict !== 'VALID') return;

  await Submission.create({
    contestId: contest._id,
    userId: msg.from.id,
    username: msg.from.username,
    fileId: file.file_id,
    fileUniqueId: file.file_unique_id,
    imageHash: hash,
    relevanceScore: ai.score,
    aiVerdict: ai.verdict,
  });

  await Score.findOneAndUpdate(
    { contestId: contest._id, userId: msg.from.id },
    {
      $inc: { totalScore: ai.score },
      $set: { username: msg.from.username },
    },
    { upsert: true }
  );

  bot.sendMessage(msg.chat.id, `✅ Score: ${ai.score}`);
});

/**
 * LEADERBOARD
 */
bot.onText(/\/leaderboard/, async (msg) => {
  const contest = await Contest.findOne({
    chatId: msg.chat.id,
    isActive: true,
  });

  if (!contest) return;

  const scores = await Score.find({ contestId: contest._id })
    .sort({ totalScore: -1 })
    .limit(10);

  let text = '🏆 Leaderboard:\n\n';

  scores.forEach((s, i) => {
    text += `${i + 1}. ${s.username} - ${s.totalScore}\n`;
  });

  bot.sendMessage(msg.chat.id, text);
});

module.exports = bot;
