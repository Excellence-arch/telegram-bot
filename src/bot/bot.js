const TelegramBot = require('node-telegram-bot-api');
const Contest = require('../models/contest.model');
const Submission = require('../models/submission.model');
const Score = require('../models/score.model');
const { getImageHash } = require('../services/hashService');
const { analyzeImage } = require('../services/aiService');
const { canUseBot, isSuperAdmin } = require('../utils/checkAdmin');
const Admin = require('../models/admin.model');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

bot.onText(/\/help/, async (msg) => {
  const allowed = await canUseBot(bot, msg.chat.id, msg.from.id);
  if (!allowed) {
    return bot.sendMessage(
      msg.chat.id,
      `Only a registered admin can use this command`,
    );
  }
  let response = `
  For this commands to work, the bot must be an admin with access to read and write messages.
  These are the list of commands that you can use on this bot:
  /startcontest description -  to start the contest with the full description of the contest. The description is what empowers the bot to know hoow to judge the screenshots and links
  /leaderboard - To get the leaderboard by ranking
  /register - To register a new admin
  /listadmins - To list all the registered admins
  /removeadmins - To remove an admin
  `;
  bot.sendMessage(msg.chat.id, response);
});

/**
 * START CONTEST
 */
bot.onText(/\/startcontest (.+)/, async (msg, match) => {
  const allowed = await canUseBot(bot, msg.chat.id, msg.from.id);
  if (!allowed) {
    return bot.sendMessage(
      msg.chat.id,
      `Only a registered admin can use this command`,
    );
  }

  const description = match[1];

  await Contest.create({
    name: 'Contest',
    description,
    chatId: msg.chat.id,
  });

  response = `
  ✅ Contest started!
  Below are the details of the contest:
${description}
  `;

  bot.sendMessage(msg.chat.id, response);
});

bot.onText(/\/register/, async (msg) => {
  const allowed = await isSuperAdmin(msg.from.id);
  if (!allowed) {
    return bot.sendMessage(
      msg.chat.id,
      `Only a super admin can use this command`,
    );
  }

  if (!msg.reply_to_message) {
    return bot.sendMessage(msg.chat.id, '❌ Reply to the user to register.');
  }

  const targetUser = msg.reply_to_message.from;

  const exists = await Admin.findOne({
    userId: targetUser.id.toString(),
  });

  if (exists) {
    return bot.sendMessage(msg.chat.id, '⚠️ Already an admin.');
  }

  await Admin.create({
    userId: targetUser.id.toString(),
    username: targetUser.username,
  });

  bot.sendMessage(
    msg.chat.id,
    `✅ @${targetUser.username || 'user'} is now an admin`,
  );
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

  if (!contest) {
    return bot.sendMessage(
      msg.chat.id,
      `If you mean for the bot to be active, Please start a contest with the command /startcontest to continue`,
    );
  }

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
    { upsert: true },
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

  if (!contest) {
    return bot.sendMessage(
      msg.chat.id,
      `A contest has not been started here. Please use the /startcontest to start a contest`,
    );
  }

  const scores = await Score.find({ contestId: contest._id })
    .sort({ totalScore: -1 })
    .limit(10);

  let text = '🏆 Leaderboard:\n\n';

  scores.forEach((s, i) => {
    text += `${i + 1}. @${s.username} - ${s.totalScore}\n`;
  });

  bot.sendMessage(msg.chat.id, text);
});

bot.onText(/\/listadmins/, async (msg) => {
  console.log(`Command recieved from ${msg.from.username} (${msg.from.id})`);
  const allowed = await isSuperAdmin(msg.from.id);
  if (!allowed) {
    return bot.sendMessage(
      msg.chat.id,
      `Only a super admin can use this command`,
    );
  }

  const admins = await Admin.find();

  if (!admins.length) {
    return bot.sendMessage(msg.chat.id, 'No admins registered.');
  }

  let text = '👑 Admins:\n\n';

  admins.forEach((admin, i) => {
    text += `${i + 1}. @${admin.username || 'no_username'} (ID: ${admin.userId})\n`;
  });

  bot.sendMessage(msg.chat.id, text);
});

bot.onText(/\/removeadmin/, async (msg) => {
  const allowed = await isSuperAdmin(msg.from.id);
  if (!allowed) {
    return bot.sendMessage(
      msg.chat.id,
      `Only a super admin can use this command`,
    );
  }

  if (!msg.reply_to_message) {
    return bot.sendMessage(
      msg.chat.id,
      '❌ Reply to the admin you want to remove.',
    );
  }

  const targetUser = msg.reply_to_message.from;

  if (targetUser.id === msg.from.id) {
    return bot.sendMessage(msg.chat.id, '❌ You cannot remove yourself.');
  }

  const deleted = await Admin.findOneAndDelete({
    userId: targetUser.id.toString(),
  });

  if (!deleted) {
    return bot.sendMessage(msg.chat.id, '⚠️ User is not an admin.');
  }

  bot.sendMessage(
    msg.chat.id,
    `✅ @${targetUser.username || 'user'} removed from admins`,
  );
});

module.exports = bot;
