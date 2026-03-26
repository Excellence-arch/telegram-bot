const Admin = require('../models/admin.model');

async function isSystemAdmin(userId) {
  const admin = await Admin.findOne({ userId });
  return !!admin;
}

async function isSuperAdmin(userId) {
  const admin = await Admin.findOne({ userId, role: 'super_admin' });
  return !!admin;
}

async function isTelegramAdmin(bot, chatId, userId) {
  const admins = await bot.getChatAdministrators(chatId);
  return admins.some((a) => a.user.id === userId);
}

async function canUseBot(bot, chatId, userId) {
  const system = await isSystemAdmin(userId);
  const telegram = await isTelegramAdmin(bot, chatId, userId);

  return system || telegram;
}

module.exports = { canUseBot, isSuperAdmin };
