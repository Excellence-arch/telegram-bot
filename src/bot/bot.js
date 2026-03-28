const TelegramBot = require('node-telegram-bot-api');
const Contest = require('../models/contest.model');
const Submission = require('../models/submission.model');
const Score = require('../models/score.model');
const { getImageHash } = require('../services/hashService');
const { analyzeImage } = require('../services/aiService');
const { canUseBot, isSuperAdmin } = require('../utils/checkAdmin');
const Admin = require('../models/admin.model');
const { Parser } = require('json2csv');
const fs = require('fs');
const path = require('path');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// Helper function to extract Twitter/X links from text
function extractTwitterLinks(text) {
  if (!text) return [];
  // Match Twitter/X links (x.com, twitter.com)
  const twitterRegex = /(https?:\/\/(?:x\.com|twitter\.com)\/[^\s]+)/g;
  const matches = text.match(twitterRegex) || [];
  return [...new Set(matches)]; // Remove duplicates
}

// Helper function to validate if a link is a valid Twitter/X URL format
function isValidTwitterUrl(link) {
  const tweetRegex = /(?:x\.com|twitter\.com)\/\w+\/status\/(\d+)/;
  return tweetRegex.test(link);
}

// Function to fetch ALL messages from a group (including before bot was added)
async function fetchAllGroupMessages(chatId) {
  try {
    console.log(`Fetching ALL messages for chat ${chatId}`);

    // Due to Telegram API limitations, we can only fetch messages
    // that were sent after the bot was added to the group AND if the group
    // has message history visible to new members

    const messages = [];
    let offset = 0;
    let attempts = 0;
    const maxAttempts = 100;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        const updates = await bot.getUpdates({
          offset: offset,
          timeout: 30,
          allowed_updates: ['message'],
        });

        if (updates.length === 0) {
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

        // Small delay to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        console.error('Error fetching updates:', error);
        break;
      }
    }

    console.log(`Fetched ${messages.length} messages total`);
    return messages;
  } catch (error) {
    console.error('Error fetching messages:', error);
    return [];
  }
}

// Function to process messages and extract links with validation
function processMessagesForLinks(messages, contestDescription) {
  const userDataMap = new Map(); // userId -> { username, links: [], screenshots: [] }

  for (const msg of messages) {
    const userId = msg.from.id.toString();
    const username =
      msg.from.username ||
      msg.from.first_name ||
      msg.from.last_name ||
      'Unknown';
    const text = msg.text || msg.caption || '';

    // Initialize user entry if not exists
    if (!userDataMap.has(userId)) {
      userDataMap.set(userId, {
        userId: userId,
        username: username,
        links: [],
        screenshots: [],
        hasScreenshot: false,
      });
    }

    const userData = userDataMap.get(userId);

    // Extract links from message
    const links = extractTwitterLinks(text);

    // Add unique links to user's link list
    for (const link of links) {
      const isValid = isValidTwitterUrl(link);
      if (isValid && !userData.links.includes(link)) {
        userData.links.push(link);
      }
    }

    // Check if message contains a screenshot (photo)
    if (msg.photo || msg.document) {
      userData.hasScreenshot = true;
      // Store screenshot info for AI analysis later
      userData.screenshots.push({
        messageId: msg.message_id,
        fileId: msg.photo
          ? msg.photo[msg.photo.length - 1].file_id
          : msg.document.file_id,
        fileUniqueId: msg.photo
          ? msg.photo[msg.photo.length - 1].file_unique_id
          : msg.document.file_unique_id,
        timestamp: msg.date,
      });
    }
  }

  return userDataMap;
}

// Function to analyze screenshots using AI and award points
async function analyzeAndScoreScreenshots(userDataMap, contest, chatId) {
  const scoreUpdates = [];

  for (const [userId, userData] of userDataMap) {
    let screenshotPoints = 0;
    let processedScreenshots = [];

    for (const screenshot of userData.screenshots) {
      try {
        // Check if this screenshot was already processed
        const existingSubmission = await Submission.findOne({
          contestId: contest._id,
          fileUniqueId: screenshot.fileUniqueId,
        });

        if (existingSubmission) {
          // Already processed, use existing score
          if (existingSubmission.relevanceScore > 0) {
            screenshotPoints += existingSubmission.relevanceScore;
            processedScreenshots.push(existingSubmission);
          }
          continue;
        }

        // Get file link and analyze with AI
        const fileLink = await bot.getFileLink(screenshot.fileId);
        const hash = await getImageHash(fileLink);

        // Check for duplicate by hash
        const hashExists = await Submission.findOne({
          contestId: contest._id,
          imageHash: hash,
        });

        if (hashExists) {
          if (hashExists.relevanceScore > 0) {
            screenshotPoints += hashExists.relevanceScore;
            processedScreenshots.push(hashExists);
          }
          continue;
        }

        // Perform AI analysis
        const aiResult = await analyzeImage(fileLink, contest.description);

        let points = 0;
        if (aiResult.verdict === 'VALID') {
          points = 1; // Award 1 point for valid screenshot
        }

        screenshotPoints += points;

        // Store submission in database
        const submission = await Submission.create({
          contestId: contest._id,
          userId: userId,
          username: userData.username,
          fileId: screenshot.fileId,
          fileUniqueId: screenshot.fileUniqueId,
          imageHash: hash,
          relevanceScore: points,
          aiVerdict: aiResult.verdict,
          aiAnalysis: aiResult,
        });

        processedScreenshots.push(submission);
      } catch (error) {
        console.error(`Error analyzing screenshot for user ${userId}:`, error);
      }
    }

    if (screenshotPoints > 0) {
      scoreUpdates.push({
        userId: userId,
        username: userData.username,
        points: screenshotPoints,
        type: 'screenshot',
      });
    }

    // Update user data with processed screenshots
    userData.screenshotPoints = screenshotPoints;
    userData.processedScreenshots = processedScreenshots;
  }

  return scoreUpdates;
}

// Function to calculate link points (1 per valid link)
function calculateLinkPoints(userDataMap) {
  const scoreUpdates = [];

  for (const [userId, userData] of userDataMap) {
    const linkPoints = userData.links.length; // 1 point per valid link

    if (linkPoints > 0) {
      scoreUpdates.push({
        userId: userId,
        username: userData.username,
        points: linkPoints,
        type: 'link',
      });
    }

    userData.linkPoints = linkPoints;
  }

  return scoreUpdates;
}

// Function to update scores in database
async function updateScoresInDatabase(contestId, userDataMap) {
  for (const [userId, userData] of userDataMap) {
    const totalPoints =
      (userData.linkPoints || 0) + (userData.screenshotPoints || 0);

    if (totalPoints > 0) {
      await Score.findOneAndUpdate(
        { contestId: contestId, userId: userId },
        {
          $set: {
            username: userData.username,
            linkScore: userData.linkPoints || 0,
            screenshotScore: userData.screenshotPoints || 0,
            totalScore: totalPoints,
          },
        },
        { upsert: true },
      );
    }
  }
}

// Function to generate CSV report
function generateCSVReport(userDataMap) {
  const csvData = [];

  for (const [userId, userData] of userDataMap) {
    const totalScore =
      (userData.linkPoints || 0) + (userData.screenshotPoints || 0);

    csvData.push({
      Username: userData.username,
      'User ID': userId,
      'Total Score': totalScore,
      'Link Score': userData.linkPoints || 0,
      'Screenshot Score': userData.screenshotPoints || 0,
      'Valid Links': userData.links.join('; '),
      'Links Count': userData.links.length,
      'Screenshots Processed': userData.screenshots.length,
      'Valid Screenshots': userData.screenshotPoints || 0,
    });
  }

  // Sort by total score descending
  csvData.sort((a, b) => b['Total Score'] - a['Total Score']);

  return csvData;
}

// Function to send report to admins
async function sendReportToAdmins(
  csvData,
  contest,
  chatId,
  initiatingAdminId,
  filepath,
) {
  const admins = await Admin.find();
  const superAdmins = admins.filter((admin) => admin.role === 'superadmin');

  const recipients = new Set();
  recipients.add(initiatingAdminId.toString());
  superAdmins.forEach((admin) => recipients.add(admin.userId));

  const summary =
    `📊 **Contest Links & Screenshots Report**\n\n` +
    `**Contest:** ${contest.name || 'Contest'}\n` +
    `**Description:** ${contest.description.substring(0, 150)}${contest.description.length > 150 ? '...' : ''}\n` +
    `**Total Participants:** ${csvData.length}\n` +
    `**Total Points Awarded:** ${csvData.reduce((sum, user) => sum + user['Total Score'], 0)}\n` +
    `**Valid Links Found:** ${csvData.reduce((sum, user) => sum + user['Links Count'], 0)}\n` +
    `**Valid Screenshots:** ${csvData.reduce((sum, user) => sum + user['Valid Screenshots'], 0)}\n\n` +
    `*Report generated on:* ${new Date().toLocaleString()}\n` +
    `*Scoring:* 1 point per valid Twitter/X link, 1 point per valid screenshot\n` +
    `*Note:* Links are validated by URL format, screenshots are validated by AI relevance to the contest task.`;

  let successCount = 0;
  let failCount = 0;

  for (const userId of recipients) {
    try {
      await bot.sendChatAction(userId, 'upload_document');
      await bot.sendDocument(userId, filepath, {
        caption: summary,
        parse_mode: 'Markdown',
      });
      successCount++;
    } catch (err) {
      console.error(`Failed to send to user ${userId}:`, err.message);
      failCount++;

      if (userId === initiatingAdminId.toString()) {
        try {
          await bot.sendDocument(chatId, filepath, {
            caption:
              summary +
              '\n\n⚠️ Could not send to your DM. Please start the bot in private first.',
            parse_mode: 'Markdown',
          });
        } catch (groupErr) {
          console.error('Failed to send to group:', groupErr);
        }
      }
    }
  }

  return { successCount, failCount };
}

/**
 * HELP COMMAND
 */
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

**Content Extraction:**
/extractlinks - Extract ALL Twitter/X links and screenshots from chat history
  • Scans all messages in the group
  • Validates Twitter/X links by URL format
  • Analyzes screenshots with AI for relevance
  • Awards 1 point per valid link and 1 point per valid screenshot
  • Generates CSV report with all participants and scores
  • Sends report to admin and super admins via DM

**Scoring System:**
• Each valid Twitter/X link: +1 point
• Each valid screenshot: +1 point
• Links are validated by proper Twitter/X URL format
• Screenshots are validated by AI for relevance to the contest task
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

**Scoring Rules:**
• 1 point for each valid Twitter/X link
• 1 point for each valid screenshot (AI-validated)

Participants can now submit:
• Twitter/X links (x.com or twitter.com)
• Screenshots (will be analyzed for relevance)

Good luck! 🎉
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

/**
 * LEADERBOARD CALLBACK HANDLER
 */
bot.on('callback_query', async (query) => {
  const data = query.data;
  const userId = query.from.id;

  let allowed = await canUseBot(bot, query.message.chat.id, userId);
  if (!allowed) {
    return bot.answerCallbackQuery(query.id, {
      text: '❌ Only a registered admin can use this action',
      show_alert: true,
    });
  }

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

  let text = '🏆 **Leaderboard:**\n\n';

  scores.forEach((s, i) => {
    text += `${i + 1}. @${s.username || 'Unknown'} - ${s.totalScore || 0} points\n`;
  });

  text += `\n*Scoring: 1 point per valid Twitter/X link, 1 point per valid screenshot*`;

  try {
    if (type === 'dm') {
      await bot.sendMessage(userId, text);
    } else {
      await bot.sendMessage(chatId, text);
    }

    await bot.answerCallbackQuery(query.id, {
      text: '✅ Sent successfully!',
    });
    return;
  } catch (err) {
    await bot.answerCallbackQuery(query.id, {
      text: '⚠️ Failed. Start bot in DM first.',
      show_alert: true,
    });
  }
});

/**
 * EXTRACT LINKS COMMAND - Enhanced Version
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
    `🔄 **Extracting and analyzing content from chat history...**\n\nThis may take a few minutes depending on the chat size.\n\nSteps:\n1️⃣ Fetching all messages\n2️⃣ Extracting Twitter/X links\n3️⃣ Analyzing screenshots with AI\n4️⃣ Calculating scores\n5️⃣ Generating report`,
    { parse_mode: 'Markdown' },
  );

  try {
    // Step 1: Fetch all messages from the group
    await bot.editMessageText(
      `📥 **Step 1/5:** Fetching all messages from the group...`,
      {
        chat_id: msg.chat.id,
        message_id: processingMsg.message_id,
        parse_mode: 'Markdown',
      },
    );

    const messages = await fetchAllGroupMessages(msg.chat.id);

    if (messages.length === 0) {
      return bot.editMessageText(
        `ℹ️ No messages found in the chat history. Make sure the bot has access to message history.`,
        {
          chat_id: msg.chat.id,
          message_id: processingMsg.message_id,
        },
      );
    }

    // Step 2: Process messages to extract links and screenshots
    await bot.editMessageText(
      `🔍 **Step 2/5:** Processing ${messages.length} messages...\n\nExtracting Twitter/X links and identifying screenshots...`,
      {
        chat_id: msg.chat.id,
        message_id: processingMsg.message_id,
        parse_mode: 'Markdown',
      },
    );

    const userDataMap = processMessagesForLinks(messages, contest.description);

    const totalLinks = Array.from(userDataMap.values()).reduce(
      (sum, u) => sum + u.links.length,
      0,
    );
    const totalScreenshots = Array.from(userDataMap.values()).reduce(
      (sum, u) => sum + u.screenshots.length,
      0,
    );

    await bot.editMessageText(
      `✅ Found ${totalLinks} Twitter/X links and ${totalScreenshots} screenshots from ${userDataMap.size} users.\n\n🤖 **Step 3/5:** Analyzing screenshots with AI...`,
      {
        chat_id: msg.chat.id,
        message_id: processingMsg.message_id,
        parse_mode: 'Markdown',
      },
    );

    // Step 3: Analyze screenshots with AI
    const screenshotUpdates = await analyzeAndScoreScreenshots(
      userDataMap,
      contest,
      msg.chat.id,
    );

    // Step 4: Calculate link points
    await bot.editMessageText(
      `📊 **Step 4/5:** Calculating points...\n\n✅ Link points: 1 per valid Twitter/X link\n✅ Screenshot points: 1 per relevant screenshot\n\nAwarding points...`,
      {
        chat_id: msg.chat.id,
        message_id: processingMsg.message_id,
        parse_mode: 'Markdown',
      },
    );

    const linkUpdates = calculateLinkPoints(userDataMap);

    // Update scores in database
    await updateScoresInDatabase(contest._id, userDataMap);

    const totalPoints =
      linkUpdates.reduce((sum, u) => sum + u.points, 0) +
      screenshotUpdates.reduce((sum, u) => sum + u.points, 0);

    // Step 5: Generate CSV report
    await bot.editMessageText(
      `📄 **Step 5/5:** Generating report...\n\nTotal points awarded: ${totalPoints}`,
      {
        chat_id: msg.chat.id,
        message_id: processingMsg.message_id,
        parse_mode: 'Markdown',
      },
    );

    const csvData = generateCSVReport(userDataMap);

    if (csvData.length === 0) {
      return bot.editMessageText(
        `ℹ️ No valid submissions found in the chat history.`,
        {
          chat_id: msg.chat.id,
          message_id: processingMsg.message_id,
        },
      );
    }

    // Generate CSV file
    const json2csvParser = new Parser({
      fields: [
        'Username',
        'User ID',
        'Total Score',
        'Link Score',
        'Screenshot Score',
        'Valid Links',
        'Links Count',
        'Screenshots Processed',
        'Valid Screenshots',
      ],
    });
    const csv = json2csvParser.parse(csvData);

    const filename = `contest_report_${contest._id}_${Date.now()}.csv`;
    const filepath = path.join(__dirname, '..', 'exports', filename);

    const exportsDir = path.join(__dirname, '..', 'exports');
    if (!fs.existsSync(exportsDir)) {
      fs.mkdirSync(exportsDir, { recursive: true });
    }

    fs.writeFileSync(filepath, csv);

    // Send report to admins
    await bot.editMessageText(`📤 Sending report to admins...`, {
      chat_id: msg.chat.id,
      message_id: processingMsg.message_id,
      parse_mode: 'Markdown',
    });

    const { successCount, failCount } = await sendReportToAdmins(
      csvData,
      contest,
      msg.chat.id,
      msg.from.id,
      filepath,
    );

    // Clean up
    fs.unlinkSync(filepath);

    // Final summary
    const finalSummary =
      `✅ **Extraction Complete!**\n\n` +
      `📊 **Statistics:**\n` +
      `• Messages analyzed: ${messages.length}\n` +
      `• Participants found: ${userDataMap.size}\n` +
      `• Valid Twitter/X links: ${totalLinks}\n` +
      `• Screenshots analyzed: ${totalScreenshots}\n` +
      `• Valid screenshots: ${screenshotUpdates.reduce((sum, u) => sum + u.points, 0)}\n\n` +
      `🏆 **Points Awarded:**\n` +
      `• Link points: ${linkUpdates.reduce((sum, u) => sum + u.points, 0)}\n` +
      `• Screenshot points: ${screenshotUpdates.reduce((sum, u) => sum + u.points, 0)}\n` +
      `• **Total points:** ${totalPoints}\n\n` +
      `📨 **Report Delivery:**\n` +
      `• ✅ Sent to ${successCount} admin(s)\n` +
      `• ❌ Failed to send to ${failCount} admin(s)\n\n` +
      `💡 **Tip:** Use /leaderboard to view the current standings in the group.`;

    await bot.editMessageText(finalSummary, {
      chat_id: msg.chat.id,
      message_id: processingMsg.message_id,
      parse_mode: 'Markdown',
    });
  } catch (error) {
    console.error('Error extracting content:', error);
    bot.editMessageText(
      `❌ **Error:** ${error.message}\n\nPlease check:\n• Bot has admin permissions\n• Bot can read messages\n• Group message history is visible\n• AI service is running\n\nTry again or contact support.`,
      {
        chat_id: msg.chat.id,
        message_id: processingMsg.message_id,
        parse_mode: 'Markdown',
      },
    );
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

  let text = '👑 Admins:\n\n';
  admins.forEach((admin, i) => {
    text += `${i + 1}. @${admin.username || 'no_username'} (ID: ${admin.userId || 'no userId'}) - ${admin.role || 'admin'}\n`;
  });

  bot.sendMessage(msg.chat.id, text);
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
 * HANDLE REAL-TIME SUBMISSIONS (Images and Links together)
 */
bot.on('message', async (msg) => {
  const contest = await Contest.findOne({
    chatId: msg.chat.id,
    isActive: true,
  });

  if (!contest) return;

  let pointsAwarded = 0;
  let responseMessage = '';

  // Handle links in the message
  const text = msg.text || msg.caption || '';
  const links = extractTwitterLinks(text);
  const validLinks = links.filter((link) => isValidTwitterUrl(link));

  if (validLinks.length > 0) {
    // Award points for valid links (1 point per link)
    const linkPoints = validLinks.length;
    pointsAwarded += linkPoints;
    responseMessage += `✅ +${linkPoints} point(s) for valid Twitter/X link(s)\n`;

    // Update score immediately
    await Score.findOneAndUpdate(
      { contestId: contest._id, userId: msg.from.id.toString() },
      {
        $inc: { linkScore: linkPoints, totalScore: linkPoints },
        $set: { username: msg.from.username || msg.from.first_name },
      },
      { upsert: true },
    );
  }

  // Handle screenshots in the message
  let hasScreenshot = false;
  let screenshotFile = null;

  if (msg.photo) {
    hasScreenshot = true;
    screenshotFile = msg.photo[msg.photo.length - 1];
  } else if (
    msg.document &&
    msg.document.mime_type &&
    msg.document.mime_type.startsWith('image/')
  ) {
    hasScreenshot = true;
    screenshotFile = msg.document;
  }

  if (hasScreenshot && screenshotFile) {
    // Check for duplicates
    const exists = await Submission.findOne({
      contestId: contest._id,
      fileUniqueId: screenshotFile.file_unique_id,
    });

    if (exists) {
      responseMessage += `ℹ️ Screenshot already submitted (${exists.relevanceScore} point(s) awarded previously)\n`;
      if (exists.relevanceScore > 0) {
        pointsAwarded += exists.relevanceScore;
      }
    } else {
      // Analyze screenshot with AI
      try {
        const fileLink = await bot.getFileLink(screenshotFile.file_id);
        const hash = await getImageHash(fileLink);

        // Check hash duplicate
        const hashExists = await Submission.findOne({
          contestId: contest._id,
          imageHash: hash,
        });

        if (hashExists) {
          responseMessage += `ℹ️ Duplicate screenshot detected (${hashExists.relevanceScore} point(s) awarded)\n`;
          if (hashExists.relevanceScore > 0) {
            pointsAwarded += hashExists.relevanceScore;
          }
        } else {
          // AI Analysis
          const aiResult = await analyzeImage(fileLink, contest.description);

          let screenshotPoints = 0;
          if (aiResult.verdict === 'VALID') {
            screenshotPoints = 1; // 1 point for valid screenshot
            pointsAwarded += screenshotPoints;
            responseMessage += `✅ +${screenshotPoints} point(s) for valid screenshot\n`;
          } else {
            responseMessage += `❌ Screenshot rejected: ${aiResult.verdict}\n`;
          }

          // Store submission
          await Submission.create({
            contestId: contest._id,
            userId: msg.from.id.toString(),
            username: msg.from.username || msg.from.first_name,
            fileId: screenshotFile.file_id,
            fileUniqueId: screenshotFile.file_unique_id,
            imageHash: hash,
            relevanceScore: screenshotPoints,
            aiVerdict: aiResult.verdict,
            aiAnalysis: aiResult,
          });

          // Update score for screenshot
          if (screenshotPoints > 0) {
            await Score.findOneAndUpdate(
              { contestId: contest._id, userId: msg.from.id.toString() },
              {
                $inc: {
                  screenshotScore: screenshotPoints,
                  totalScore: screenshotPoints,
                },
                $set: { username: msg.from.username || msg.from.first_name },
              },
              { upsert: true },
            );
          }
        }
      } catch (error) {
        console.error('Error processing screenshot:', error);
        responseMessage += `❌ Error processing screenshot. Please try again.\n`;
      }
    }
  }

  // Send response if points were awarded or there was an error
  if (responseMessage) {
    if (pointsAwarded > 0) {
      responseMessage =
        `🎉 **+${pointsAwarded} point(s) awarded!** 🎉\n\n` + responseMessage;
      responseMessage += `\n📊 Total points updated! Use /leaderboard to see rankings.`;
    }
    bot.sendMessage(msg.chat.id, responseMessage, { parse_mode: 'Markdown' });
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
      bot.sendMessage(
        msg.chat.id,
        `🤖 Bot has joined!\n\nActive contest found. Use /extractlinks to analyze existing messages and award points for valid Twitter/X links and screenshots.`,
      );
    } else {
      bot.sendMessage(
        msg.chat.id,
        `🤖 Bot is ready!\n\nUse /help to see available commands.\n\nTo start a contest, use /startcontest [description]`,
      );
    }
  }
});

module.exports = bot;
