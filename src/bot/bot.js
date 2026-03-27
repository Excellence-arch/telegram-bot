const TelegramBot = require('node-telegram-bot-api');
const Contest = require('../models/contest.model');
const Submission = require('../models/submission.model');
const Score = require('../models/score.model');
const UserLink = require('../models/userlink.model'); // New model for tracking links
const { getImageHash } = require('../services/hashService');
const { analyzeImage } = require('../services/aiService');
const { canUseBot, isSuperAdmin } = require('../utils/checkAdmin');
const Admin = require('../models/admin.model');
const { Parser } = require('json2csv');
const fs = require('fs');
const path = require('path');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// Helper function to extract links from message
function extractLinks(text) {
  if (!text) return [];
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.match(urlRegex) || [];
}

// Function to fetch historical messages
async function fetchHistoricalMessages(chatId, contest) {
  try {
    console.log(`Fetching historical messages for chat ${chatId}`);

    // Get all messages since the contest started
    let offset = 0;
    const messages = [];
    let hasMore = true;

    while (hasMore) {
      const updates = await bot.getUpdates({
        offset: offset,
        timeout: 10,
        allowed_updates: ['message'],
      });

      if (updates.length === 0) {
        hasMore = false;
        break;
      }

      for (const update of updates) {
        if (
          update.message &&
          update.message.chat.id.toString() === chatId.toString()
        ) {
          messages.push(update.message);
        }
        offset = update.update_id + 1;
      }

      // Limit to avoid infinite loop
      if (messages.length > 1000) break;
    }

    // Process historical messages for links
    for (const msg of messages) {
      const userId = msg.from.id;
      const username = msg.from.username;
      const text = msg.text || msg.caption || '';

      const links = extractLinks(text);

      for (const link of links) {
        // Check if this link has been processed
        const exists = await UserLink.findOne({
          contestId: contest._id,
          userId: userId.toString(),
          link: link,
        });

        if (!exists) {
          await UserLink.create({
            contestId: contest._id,
            userId: userId.toString(),
            username: username,
            link: link,
            messageId: msg.message_id,
            timestamp: msg.date,
          });
        }
      }
    }

    console.log(`Processed ${messages.length} historical messages`);
  } catch (error) {
    console.error('Error fetching historical messages:', error);
  }
}

bot.onText(/\/help/, async (msg) => {
  const allowed = await canUseBot(bot, msg.chat.id, msg.from.id);
  if (!allowed) {
    return bot.sendMessage(
      msg.chat.id,
      `Only a registered admin can use this command`,
    );
  }
  let response = `
🎮 **Bot Commands** 🎮

For these commands to work, the bot must be an admin with access to read and write messages.

**Contest Management:**
/startcontest <description> - Start a new contest with the judging criteria
/stopcontest - Stop the current contest
/leaderboard - View current leaderboard

**Admin Management:**
/register - Register a new admin (reply to user)
/listadmins - List all registered admins
/removeadmin - Remove an admin (reply to user)

**Link Management:**
/extractlinks - Extract all links from chat history and export as CSV
  `;
  bot.sendMessage(msg.chat.id, response, { parse_mode: 'Markdown' });
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
  const chatId = msg.chat.id;

  // Check if there's an active contest
  const existingContest = await Contest.findOne({
    chatId: chatId,
    isActive: true,
  });
  if (existingContest) {
    return bot.sendMessage(
      msg.chat.id,
      `⚠️ There's already an active contest. Use /stopcontest first to end it.`,
    );
  }

  const contest = await Contest.create({
    name: 'Contest',
    description,
    chatId: chatId,
    startDate: new Date(),
  });

  const response = `
✅ **Contest Started!**

**Contest Details:**
${description}

Participants can now submit screenshots and links. Good luck! 🎉
  `;

  bot.sendMessage(msg.chat.id, response);
});

/**
 * STOP CONTEST
 */
bot.onText(/\/stopcontest/, async (msg) => {
  const allowed = await canUseBot(bot, msg.chat.id, msg.from.id);
  if (!allowed) {
    return bot.sendMessage(
      msg.chat.id,
      `Only a registered admin can use this command`,
    );
  }

  const contest = await Contest.findOne({
    chatId: msg.chat.id,
    isActive: true,
  });

  if (!contest) {
    return bot.sendMessage(
      msg.chat.id,
      `❌ No active contest found in this chat.`,
    );
  }

  contest.isActive = false;
  contest.endDate = new Date();
  await contest.save();

  const scores = await Score.find({ contestId: contest._id })
    .sort({ totalScore: -1 })
    .limit(3);

  let resultText = `🏆 **Contest Ended!** 🏆\n\n`;
  resultText += `**Final Leaderboard:**\n`;

  scores.forEach((s, i) => {
    resultText += `${i + 1}. @${s.username || 'Unknown'} - ${s.totalScore} points\n`;
  });

  resultText += `\nThank you to all participants! 🎉`;

  bot.sendMessage(msg.chat.id, resultText);
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
      `A contest has not been started here. Please use /startcontest to start a contest`,
    );
  }

  return bot.sendMessage(msg.chat.id, '📊 Where do you want the leaderboard?', {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📩 Send to DM', callback_data: `lb_dm_${msg.chat.id}` },
          {
            text: '👥 Send to Group',
            callback_data: `lb_group_${msg.chat.id}`,
          },
        ],
      ],
    },
  });

  
});

bot.on('callback_query', async (query) => {
  const data = query.data;
  const userId = query.from.id;

  if (!data.startsWith('lb_')) return;

  const [, type, chatId] = data.split('_');

  const contest = await Contest.findOne({
    chatId: chatId,
    isActive: true,
  });

  if (!contest) {
    return bot.answerCallbackQuery(query.id, {
      text: '❌ No active contest',
      show_alert: true,
    });
  }

  const scores = await Score.find({ contestId: contest._id })
    .sort({ totalScore: -1 })
    .limit(10);

  let text = '🏆 Leaderboard:\n\n';

  scores.forEach((s, i) => {
    text += `${i + 1}. @${s.username || 'Unknown'} - ${s.totalScore}\n`;
  });

  try {
    if (type === 'dm') {
      await bot.sendMessage(userId, text);
    } else {
      await bot.sendMessage(chatId, text);
    }

    await bot.answerCallbackQuery(query.id, {
      text: '✅ Sent successfully!',
    });
    // bot.editMessageReplyMarkup(
    //   { inline_keyboard: [] },
    //   {
    //     chat_id: query.chatId,
    //     message_id: query.message.message_id,
    //   },
    // );

    return;
  } catch (err) {
    await bot.answerCallbackQuery(query.id, {
      text: '⚠️ Failed. Start bot in DM first.',
      show_alert: true,
    });
  }
});

/**
 * EXTRACT LINKS FROM CHAT HISTORY
 */
bot.onText(/\/extractlinks/, async (msg) => {
  const allowed = await canUseBot(bot, msg.chat.id, msg.from.id);
  if (!allowed) {
    return bot.sendMessage(
      msg.chat.id,
      `Only a registered admin can use this command`,
    );
  }

  const contest = await Contest.findOne({
    chatId: msg.chat.id,
    isActive: true,
  });

  if (!contest) {
    return bot.sendMessage(
      msg.chat.id,
      `❌ No active contest found in this chat.`,
    );
  }

  const processingMsg = await bot.sendMessage(
    msg.chat.id,
    `🔄 Extracting links from chat history... This may take a few moments.`,
  );

  try {
    // Get all submissions for this contest
    const submissions = await Submission.find({
      contestId: contest._id,
    }).populate('userId');

    // Get all user links
    const userLinks = await UserLink.find({
      contestId: contest._id,
    });

    // Prepare data for CSV
    const csvData = [];

    // Group links by user
    const userMap = new Map();

    userLinks.forEach((link) => {
      if (!userMap.has(link.userId)) {
        userMap.set(link.userId, {
          userId: link.userId,
          username: link.username,
          links: [],
        });
      }
      userMap.get(link.userId).links.push(link.link);
    });

    // Add submission scores to the data
    for (const [userId, userData] of userMap) {
      const submission = submissions.find(
        (s) => s.userId.toString() === userId,
      );
      userData.score = submission ? submission.relevanceScore : 0;
      userData.links = userData.links.join('; ');

      csvData.push({
        Username: userData.username || 'Unknown',
        'User ID': userData.userId,
        Score: userData.score,
        Links: userData.links,
      });
    }

    // Also add users who submitted but didn't post links
    submissions.forEach((submission) => {
      if (!userMap.has(submission.userId.toString())) {
        csvData.push({
          Username: submission.username || 'Unknown',
          'User ID': submission.userId,
          Score: submission.relevanceScore,
          Links: 'No links found',
        });
      }
    });

    if (csvData.length === 0) {
      return bot.editMessageText(`ℹ️ No links found in the chat history.`, {
        chat_id: msg.chat.id,
        message_id: processingMsg.message_id,
      });
    }

    // Generate CSV
    const json2csvParser = new Parser({
      fields: ['Username', 'User ID', 'Score', 'Links'],
    });
    const csv = json2csvParser.parse(csvData);

    // Save CSV to file
    const filename = `links_export_${contest._id}_${Date.now()}.csv`;
    const filepath = path.join(__dirname, '..', 'exports', filename);

    // Ensure exports directory exists
    const exportsDir = path.join(__dirname, '..', 'exports');
    if (!fs.existsSync(exportsDir)) {
      fs.mkdirSync(exportsDir, { recursive: true });
    }

    fs.writeFileSync(filepath, csv);

    try {
      // Send CSV file
      await bot.sendDocument(msg.from.id, filepath, {
        caption: `📊 **Links Export**\n\nTotal users: ${csvData.length}\nContest: ${contest.name || 'Current Contest'}\nGenerated: ${new Date().toLocaleString()}`,
        parse_mode: 'Markdown',
      });
    } catch (err) {
      await bot.sendMessage(
        msg.chat.id,
        "⚠️ I couldn't send you a DM. Please start the bot in private first.",
      );

      await bot.sendDocument(msg.chat.id, filepath, {
        caption: `📊 **Links Export**\n\nTotal users: ${csvData.length}\nContest: ${contest.name || 'Current Contest'}\nGenerated: ${new Date().toLocaleString()}`,
        parse_mode: 'Markdown',
      });
    }

    // Clean up file
    fs.unlinkSync(filepath);

    await bot.editMessageText(
      `✅ Links extracted successfully!\n📊 ${csvData.length} users found with links.`,
      {
        chat_id: msg.chat.id,
        message_id: processingMsg.message_id,
      },
    );
  } catch (error) {
    console.error('Error extracting links:', error);
    bot.editMessageText(`❌ Error extracting links: ${error.message}`, {
      chat_id: msg.chat.id,
      message_id: processingMsg.message_id,
    });
  }
});

/**
 * REGISTER ADMIN
 */
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
    role: 'admin',
  });

  bot.sendMessage(
    msg.chat.id,
    `✅ @${targetUser.username || 'user'} is now an admin`,
  );
});

/**
 * LIST ADMINS
 */
bot.onText(/\/listadmins/, async (msg) => {
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

  let text = '👑 **Admins:**\n\n';
  admins.forEach((admin, i) => {
    text += `${i + 1}. @${admin.username || 'no_username'} (ID: ${admin.userId || 'no userId'}) - ${admin.role || 'admin'}\n`;
  });

  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

/**
 * REMOVE ADMIN
 */
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

/**
 * HANDLE SUBMISSIONS (Images)
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
      `⚠️ No active contest found. Use /startcontest to begin!`,
    );
  }

  const file = msg.photo ? msg.photo.pop() : msg.document;

  // Duplicate check by file unique ID
  const exists = await Submission.findOne({
    contestId: contest._id,
    fileUniqueId: file.file_unique_id,
  });

  if (exists) return;

  const fileLink = await bot.getFileLink(file.file_id);
  const hash = await getImageHash(fileLink);

  // Duplicate check by hash
  const hashExists = await Submission.findOne({
    contestId: contest._id,
    imageHash: hash,
  });

  if (hashExists) return;

  // AI Analysis
  const ai = await analyzeImage(fileLink, contest.description);

  if (ai.verdict !== 'VALID') {
    return bot.sendMessage(
      msg.chat.id,
      `❌ Submission rejected: ${ai.verdict}`,
    );
  }

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
 * HANDLE TEXT MESSAGES (Links)
 */
bot.on('text', async (msg) => {
  const contest = await Contest.findOne({
    chatId: msg.chat.id,
    isActive: true,
  });

  if (!contest) return;

  const links = extractLinks(msg.text);

  if (links.length > 0) {
    for (const link of links) {
      const exists = await UserLink.findOne({
        contestId: contest._id,
        userId: msg.from.id.toString(),
        link: link,
      });

      if (!exists) {
        await UserLink.create({
          contestId: contest._id,
          userId: msg.from.id.toString(),
          username: msg.from.username,
          link: link,
          messageId: msg.message_id,
          timestamp: msg.date,
        });
      }
    }
  }
});

/**
 * HANDLE GROUP JOIN (Bot added to group)
 */
bot.on('new_chat_members', async (msg) => {
  const botId = (await bot.getMe()).id;
  const newMember = msg.new_chat_members.find((member) => member.id === botId);

  if (newMember) {
    // Bot was added to the group
    const activeContest = await Contest.findOne({
      chatId: msg.chat.id,
      isActive: true,
    });

    if (activeContest) {
      await fetchHistoricalMessages(msg.chat.id, activeContest);
      bot.sendMessage(
        msg.chat.id,
        `🤖 Bot has joined!\n\nActive contest found. Processing historical messages for links...`,
      );
    } else {
      bot.sendMessage(
        msg.chat.id,
        `🤖 Bot is ready!\n\nUse /help to see available commands.`,
      );
    }
  }
});

module.exports = bot;
